/*
 * vm_hud_esp32.ino - Virtual VietMap HUD (`HUD(BLE)`) Bridge for BMW MGU iDrive 7 (`bimmer-drive`)
 *
 * Boards: ESP32-C6 SuperMini (khuyên dùng), ESP32-C3, ESP32-S3, ESP32 (Arduino-ESP32 3.x).
 *   - Phát BLE GATT Service 0000FFF0-0000-1000-8000-00805F9B34FB tên "vietmap-HUD_V3(BLE)"
 *   - Notify: 0000FFF1-...  |  Write: 0000FFF2-...
 *   - Tự bắt tay với VietMap Live (cmd 0x0E -> MODEL:H1N...PROTOCOL:2.2.2)
 *   - Xuất JSON qua USB Serial (115200) cho `bimmer-drive`:
 *       {"t":"vmhud","v":1,"limit":60,"next":50,"dist":200,"camType":1,"connected":true,"model":"H1N"}
 *   - RAW_LOG=1: in thêm mọi byte VietMap gửi / ESP32 trả về dạng
 *       {"t":"raw","dir":"rx","ms":1234,"hex":"a55a37c3..."}
 *     bimmer-drive bỏ qua dòng "raw", nên để bật khi cắm trên xe cũng không sao.
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

#define RAW_LOG 1

#define SERVICE_UUID   "0000fff0-0000-1000-8000-00805f9b34fb"
#define NOTIFY_UUID    "0000fff1-0000-1000-8000-00805f9b34fb"
#define WRITE_UUID     "0000fff2-0000-1000-8000-00805f9b34fb"
/* Tên phát sóng quyết định VietMap Live có nhận mạch hay không (đo trên bản 3.4.5, Android):
 *   - phải có "vietmap" thì app mới liệt kê;
 *   - phải có "HUD_V3(BLE)" thì app mới kết nối bằng BLE (FFF0/FFF1/FFF2).
 *     Tên khác (kể cả "vietmap-hud(BLE)") bị app coi là HUD đời cũ và kết nối bằng
 *     Bluetooth thường (SPP), thứ ESP32-S3/C3/C6 không có -> kết nối nhảy liên tục. */
#define DEVICE_NAME    "vietmap-HUD_V3(BLE)"

/* Tên phát sóng có thể đổi qua USB Serial mà không cần nạp lại:
 *   gửi dòng  name=HUD-1234  -> lưu vào flash rồi tự khởi động lại
 *   gửi dòng  name=          -> quay về tên mặc định */
static Preferences prefs;
static String advName = DEVICE_NAME;
static String serialLine;


/*
 * Mọi việc (phân tích, in Serial, gửi BLE) đều chạy trong loop().
 * Callback BLE (task khác) chỉ đẩy byte vào hàng đợi rxQ và bật cờ sự kiện,
 * để các dòng JSON không bị trộn vào nhau và rxBuf chỉ một task chạm vào.
 */
static BLECharacteristic* pNotifyChar = nullptr;
static volatile bool bleConnected = false;
static volatile bool evConnect = false;
static volatile bool evDisconnect = false;
static bool sendWelcomePending = false;
static unsigned long connectedAtMs = 0;
static unsigned long lastEmitMs = 0;
static unsigned long lastCamMs = 0;
static uint32_t camFrames = 0;
static unsigned long lastRxMs = 0;
static uint32_t rxPartial = 0;

static uint8_t rxBuf[1024];
static size_t rxLen = 0;

static int currentLimit = 0;
static int nextLimit = 0;
static int currentDist = 0;
static int currentCamType = 0;

/* ---- Hàng đợi nhận: onWrite chỉ chép gói vào đây, loop() lấy ra xử lý ---- */
#define RXQ_SLOTS 16
struct RxItem { uint16_t len; uint8_t data[512]; };
static RxItem rxQ[RXQ_SLOTS];
static volatile uint8_t rxHead = 0, rxTail = 0;
static volatile uint32_t rxDropped = 0;
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;

static void pushRx(const uint8_t* data, size_t n) {
    if (n > sizeof(rxQ[0].data)) n = sizeof(rxQ[0].data);
    portENTER_CRITICAL(&rxMux);
    uint8_t next = (rxHead + 1) % RXQ_SLOTS;
    if (next != rxTail) {
        rxQ[rxHead].len = (uint16_t)n;
        memcpy(rxQ[rxHead].data, data, n);
        rxHead = next;
    } else {
        rxDropped++;
    }
    portEXIT_CRITICAL(&rxMux);
}

static bool popRx(RxItem& out) {
    bool ok = false;
    portENTER_CRITICAL(&rxMux);
    if (rxTail != rxHead) {
        out.len = rxQ[rxTail].len;
        memcpy(out.data, rxQ[rxTail].data, out.len);
        rxTail = (rxTail + 1) % RXQ_SLOTS;
        ok = true;
    }
    portEXIT_CRITICAL(&rxMux);
    return ok;
}

static void clearRxQueue() {
    portENTER_CRITICAL(&rxMux);
    rxTail = rxHead;
    portEXIT_CRITICAL(&rxMux);
}

static void logHex(const char* dir, const uint8_t* data, size_t n) {
#if RAW_LOG
    static const char* H = "0123456789abcdef";
    Serial.printf("{\"t\":\"raw\",\"dir\":\"%s\",\"ms\":%lu,\"n\":%u,\"hex\":\"", dir, millis(), (unsigned)n);
    for (size_t i = 0; i < n; i++) { Serial.write(H[data[i] >> 4]); Serial.write(H[data[i] & 15]); }
    Serial.print("\"}\n");
#endif
}

static void sendC3Frame(uint8_t cmd, const uint8_t* body, size_t bodyLen) {
    if (!pNotifyChar || !bleConnected) return;
    size_t lenField = bodyLen + 13;
    size_t total = lenField + 8;
    if (total > 256) return;
    uint8_t frame[256];
    memset(frame, 0, total);
    frame[0] = 0xA5; frame[1] = 0x5A; frame[2] = 0x37; frame[3] = 0xC3;
    frame[4] = (lenField >> 24) & 0xFF; frame[5] = (lenField >> 16) & 0xFF;
    frame[6] = (lenField >> 8) & 0xFF;  frame[7] = lenField & 0xFF;
    uint32_t sec = (uint32_t)(millis() / 1000UL);
    frame[8] = (sec >> 24) & 0xFF; frame[9] = (sec >> 16) & 0xFF;
    frame[10] = (sec >> 8) & 0xFF; frame[11] = sec & 0xFF;
    frame[12] = cmd;
    if (bodyLen > 0 && body != nullptr) memcpy(frame + 13, body, bodyLen);
    logHex("tx", frame, total);
    for (size_t off = 0; off < total; off += 20) {
        size_t chunk = total - off;
        if (chunk > 20) chunk = 20;
        pNotifyChar->setValue(frame + off, chunk);
        pNotifyChar->notify();
        delay(15);
    }
}

static void sendHudInfo() {
    const char* info = "MODEL:H1N,HW:1.0,FW:1.0,PROTOCOL:2.2.2,OBDV:1_1,SID:0";
    sendC3Frame(0x0E, (const uint8_t*)info, strlen(info));
}

static void emitJson() {
    lastEmitMs = millis();
    long camAge = lastCamMs ? (long)(millis() - lastCamMs) : -1;
    Serial.printf(
        "{\"t\":\"vmhud\",\"v\":1,\"limit\":%d,\"next\":%d,\"dist\":%d,\"camType\":%d,\"connected\":%s,\"model\":\"H1N\",\"camAgeMs\":%ld,\"camFrames\":%lu,\"rxDrop\":%lu,\"rxPartial\":%lu}\n",
        currentLimit, nextLimit, currentDist, currentCamType,
        bleConnected ? "true" : "false", camAge, (unsigned long)camFrames,
        (unsigned long)rxDropped, (unsigned long)rxPartial);
}

static void handleCameraTuples(const uint8_t* data, size_t count) {
    if (count == 0) return;
    lastCamMs = millis();
    camFrames++;
    int bestSpeed = 0, bestDist = 999999, bestType = data[0];
    int altSpeed = 0, altDist = 999999;
    for (size_t i = 0; i < count; i++) {
        uint8_t ctype = data[i * 4];
        uint16_t dist = ((uint16_t)data[i * 4 + 1] << 8) | data[i * 4 + 2];
        uint8_t spd = data[i * 4 + 3];
        if (spd >= 5 && spd <= 199) {
            if (dist == 0 && (bestSpeed == 0 || bestDist != 0)) { bestSpeed = spd; bestDist = 0; bestType = ctype; }
            else if (dist < bestDist) { bestSpeed = spd; bestDist = dist; bestType = ctype; }
        }
    }
    if (bestSpeed > 0) {
        for (size_t i = 0; i < count; i++) {
            uint16_t dist = ((uint16_t)data[i * 4 + 1] << 8) | data[i * 4 + 2];
            uint8_t spd = data[i * 4 + 3];
            if (spd >= 5 && spd <= 199 && spd != bestSpeed && dist > 0 && dist < altDist) { altSpeed = spd; altDist = dist; }
        }
    }
    currentLimit = bestSpeed;
    nextLimit = altSpeed;
    currentDist = (bestSpeed > 0 && bestDist < 999999) ? bestDist : ((int)((data[1] << 8) | data[2]));
    currentCamType = bestType;
    emitJson();
}

/* Xử lý một lệnh C3 (cmd + body). Dùng chung cho khung đủ và khung bị cụt. */
static void handleC3Command(uint8_t cmd, const uint8_t* body, size_t bodyLen) {
    if (cmd == 0x01) {
        if (bodyLen >= 4) handleCameraTuples(body, bodyLen / 4);
    } else if (cmd == 0x0E) {
        sendHudInfo();
        emitJson();
    } else if (cmd == 0x50) {
        uint8_t v = 0x64; sendC3Frame(0x50, &v, 1);
    } else if (cmd == 0x51) {
        uint8_t v = 0x03; sendC3Frame(0x51, &v, 1);
    } else if (cmd == 0x53) {
        uint8_t v[3] = {0x01, 0x00, 0x07}; sendC3Frame(0x53, v, 3);
    }
}

static void parseRxBuffer() {
    while (rxLen >= 4) {
        size_t syncIdx = rxLen;
        for (size_t i = 0; i + 3 < rxLen; i++) {
            if (rxBuf[i] == 0xA5 && rxBuf[i + 1] == 0x5A && rxBuf[i + 2] == 0x37 &&
                (rxBuf[i + 3] == 0xC3 || rxBuf[i + 3] == 0xC5)) { syncIdx = i; break; }
        }
        if (syncIdx == rxLen) {
            if (rxLen > 3) { memmove(rxBuf, rxBuf + (rxLen - 3), 3); rxLen = 3; }
            return;
        }
        if (syncIdx > 0) { memmove(rxBuf, rxBuf + syncIdx, rxLen - syncIdx); rxLen -= syncIdx; }
        if (rxLen < 8) return;

        uint32_t lenVal = ((uint32_t)rxBuf[4] << 24) | ((uint32_t)rxBuf[5] << 16) |
                          ((uint32_t)rxBuf[6] << 8) | rxBuf[7];
        if (rxBuf[3] == 0xC5) {
            if (lenVal < 5 || lenVal > 800) { memmove(rxBuf, rxBuf + 1, rxLen - 1); rxLen--; continue; }
            size_t total = 4 + lenVal + 2;
            if (rxLen < total) return;
            uint8_t cmd = rxBuf[8];
            if (cmd == 0x01 && lenVal >= 9) handleCameraTuples(rxBuf + 9, 1);
            memmove(rxBuf, rxBuf + total, rxLen - total);
            rxLen -= total;
        } else {
            if (lenVal < 13 || lenVal > 900) { memmove(rxBuf, rxBuf + 1, rxLen - 1); rxLen--; continue; }
            size_t total = lenVal + 8;
            if (rxLen < total) return;
            /* Chép khung ra rồi bỏ khỏi rxBuf trước khi trả lời (sendC3Frame có delay) */
            static uint8_t body[900];
            uint8_t cmd = rxBuf[12];
            size_t bodyLen = total - 21;
            memcpy(body, rxBuf + 13, bodyLen);
            memmove(rxBuf, rxBuf + total, rxLen - total);
            rxLen -= total;
            handleC3Command(cmd, body, bodyLen);
        }
    }
}

/*
 * Android gửi mỗi lệnh trong MỘT lần ghi và không xin tăng MTU, nên một lệnh dài
 * hơn 20 byte có thể tới thiếu phần đuôi. Khi lần ghi kế tiếp lại bắt đầu bằng
 * A5 5A 37 C3, hoặc im lặng quá RX_PARTIAL_MS, ta xử lý phần đã nhận được.
 */
#define RX_PARTIAL_MS 120

static void flushPartialFrame() {
    if (rxLen >= 13 && rxBuf[0] == 0xA5 && rxBuf[1] == 0x5A && rxBuf[2] == 0x37 && rxBuf[3] == 0xC3) {
        uint32_t lenVal = ((uint32_t)rxBuf[4] << 24) | ((uint32_t)rxBuf[5] << 16) |
                          ((uint32_t)rxBuf[6] << 8) | rxBuf[7];
        if (lenVal >= 13 && lenVal <= 900) {
            static uint8_t body[64];
            uint8_t cmd = rxBuf[12];
            size_t want = lenVal - 13;
            size_t have = rxLen - 13;
            size_t bodyLen = want < have ? want : have;
            if (bodyLen > sizeof(body)) bodyLen = sizeof(body);
            memcpy(body, rxBuf + 13, bodyLen);
            rxLen = 0;
            rxPartial++;
            handleC3Command(cmd, body, bodyLen);
            return;
        }
    }
    rxLen = 0;
}

static bool startsWithMagic(const uint8_t* d, size_t n) {
    return n >= 4 && d[0] == 0xA5 && d[1] == 0x5A && d[2] == 0x37 && (d[3] == 0xC3 || d[3] == 0xC5);
}

class ServerCB : public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) override {
        bleConnected = true;
        evConnect = true;
    }
    void onDisconnect(BLEServer* pServer) override {
        bleConnected = false;
        evDisconnect = true;
    }
};

class WriteCB : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) override {
        String val = pCharacteristic->getValue();
        if (val.length() == 0) return;
        pushRx((const uint8_t*)val.c_str(), val.length());
    }
};

static void handleBleEvents() {
    if (evDisconnect) {
        evDisconnect = false;
        evConnect = bleConnected;   /* đã nối lại ngay sau khi rớt */
        sendWelcomePending = false;
        currentLimit = 0; nextLimit = 0; currentDist = 0; currentCamType = 0;
        rxLen = 0;
        clearRxQueue();
        Serial.print("{\"t\":\"raw\",\"dir\":\"evt\",\"hex\":\"\",\"evt\":\"disconnect\"}\n");
        emitJson();
        if (!bleConnected) { delay(50); BLEDevice::startAdvertising(); }
    }
    if (evConnect) {
        evConnect = false;
        connectedAtMs = millis();
        sendWelcomePending = true;
        rxLen = 0;
        Serial.print("{\"t\":\"raw\",\"dir\":\"evt\",\"hex\":\"\",\"evt\":\"connect\"}\n");
        emitJson();
    }
}

static void drainRx() {
    static RxItem it;
    while (popRx(it)) {
        logHex("rx", it.data, it.len);
        if (rxLen > 0 && startsWithMagic(it.data, it.len)) flushPartialFrame();
        if (rxLen + it.len > sizeof(rxBuf)) rxLen = 0;
        memcpy(rxBuf + rxLen, it.data, it.len);
        rxLen += it.len;
        lastRxMs = millis();
        parseRxBuffer();
    }
    if (rxLen > 0 && (millis() - lastRxMs) >= RX_PARTIAL_MS) flushPartialFrame();
}

static void pollSerialConfig() {
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\r') continue;
        if (c != '\n') { if (serialLine.length() < 64) serialLine += c; continue; }
        if (serialLine.startsWith("name=")) {
            String n = serialLine.substring(5);
            n.trim();
            prefs.begin("vmhud", false);
            if (n.length() == 0) prefs.remove("name"); else prefs.putString("name", n);
            prefs.end();
            Serial.printf("{\"t\":\"raw\",\"dir\":\"evt\",\"hex\":\"\",\"evt\":\"rename\",\"name\":\"%s\"}\n", n.c_str());
            Serial.flush();
            delay(100);
            ESP.restart();
        }
        serialLine = "";
    }
}

void setup() {
    Serial.begin(115200);
    prefs.begin("vmhud", true);
    advName = prefs.getString("name", DEVICE_NAME);
    prefs.end();
    if (advName.length() == 0 || advName.length() > 20) advName = DEVICE_NAME;
    BLEDevice::init(advName.c_str());
    BLEDevice::setMTU(200);

    BLEServer* pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCB());

    BLEService* pService = pServer->createService(SERVICE_UUID);
    pNotifyChar = pService->createCharacteristic(
        NOTIFY_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
    pNotifyChar->addDescriptor(new BLE2902());

    BLECharacteristic* pWriteChar = pService->createCharacteristic(
        WRITE_UUID, BLECharacteristic::PROPERTY_WRITE);
    /* Chỉ khai "ghi có trả lời": nếu khai thêm WRITE_NR, Android tự chọn ghi không
       trả lời và cắt mỗi lần ghi còn 20 byte (lệnh 0x0E của VietMap dài 22 byte). */
    pWriteChar->setCallbacks(new WriteCB());

    pService->start();
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    /* Gói quảng bá chính tự dựng: cờ + UUID 16-bit FFF0 + tên đầy đủ (17 byte).
       VietMap quét kiểu Bluetooth thường và lọc theo tên ngay ở gói đầu tiên,
       nên tên không được nằm ở gói phản hồi (scan response). */
    BLEAdvertisementData advData;
    advData.setFlags(0x06);
    advData.setCompleteServices(BLEUUID((uint16_t)0xFFF0));
    advData.setName(advName);
    BLEAdvertisementData scanData;
    scanData.setName(advName);
    pAdvertising->setAdvertisementData(advData);
    pAdvertising->setScanResponseData(scanData);
    BLEDevice::startAdvertising();
    emitJson();
}

void loop() {
    pollSerialConfig();
    handleBleEvents();
    drainRx();
    if (bleConnected && sendWelcomePending && (millis() - connectedAtMs >= 300)) {
        sendWelcomePending = false;
        sendHudInfo();
    }
    if (millis() - lastEmitMs >= 1000) emitJson();
    delay(5);
}
