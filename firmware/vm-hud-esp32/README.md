# Cầu nối Virtual VietMap HUD (`HUD(BLE)`) dùng ESP32-C3 / ESP32

Firmware gọn nhẹ biến một mạch **ESP32-C3** (hoặc ESP32 thường / ESP32-S3, giá ~50–80k) thành thiết bị giả lập **`HUD(BLE)`** chính chủ của VietMap Live — **cắm thẳng cổng USB trên xe BMW MGU** làm cầu truyền dữ liệu tốc độ sang `bimmer-drive` (không cần mở màn hình điện thoại, không cần Wi-Fi hotspot).

> Khi nào cần dùng ESP32?
> * Dịch vụ `bimmer-drive` sẽ **tự động thử phát sóng BLE trực tiếp bằng Bluetooth của xe BMW (`dbus-bluez-hud.js`)** trước tiên.
> * Nếu BMW khóa BlueZ D-Bus GATT Server hoặc không cấp quyền advertise BLE, bạn chỉ cần cắm mạch ESP32 nhỏ bằng ngón tay này vào cổng USB dữ liệu trong hộc tì tay: `bimmer-drive` tự nhận diện `/dev/ttyACM0` hoặc `/dev/ttyUSB0` ngay lập tức!

## Cách nạp firmware bằng Arduino IDE
1. Cài **Arduino IDE** + Board Manager **`esp32` by Espressif Systems** (bản 2.x hoặc 3.x).
2. Chọn board:
   * **ESP32-C6 SuperMini:** `ESP32C6 Dev Module`, bật **USB CDC On Boot: Enabled** (cần Arduino-ESP32 **3.x**, khuyên 3.1 trở lên).
   * ESP32-C3 SuperMini: `ESP32C3 Dev Module`, cũng bật **USB CDC On Boot: Enabled**.
   * Nếu không nạp được: giữ nút **BOOT**, bấm **RST**, nhả BOOT rồi bấm Upload.
3. Mở file [`vm_hud_esp32.ino`](./vm_hud_esp32.ino) -> bấm **Upload**.
4. Cắm mạch vào cổng USB trên xe (hoặc test thử trên máy tính), mở **VietMap Live -> Kết nối HUD**, chọn **`HUD(BLE)`**.

## Định dạng dữ liệu qua USB Serial (115200 baud)
```json
{"t":"vmhud","v":1,"limit":60,"next":50,"dist":200,"camType":1,"connected":true,"model":"H1N"}
```
`bimmer-drive` tự động đọc dòng JSON này từ `/dev/ttyACM*` / `/dev/ttyUSB*`, cập nhật biển P.127 trên đồng hồ + kính lái HUD ngay lập tức mà không cần nhập mã ghép đôi 6 số.

## Thử với VietMap Live trước khi ra xe (chế độ `RAW_LOG`)
Firmware mặc định bật `RAW_LOG 1`: ngoài dòng `vmhud`, còn in mọi byte VietMap gửi (`"dir":"rx"`) và ESP32 trả lời (`"dir":"tx"`). `bimmer-drive` tự bỏ qua các dòng `"t":"raw"`.

Trên Mac: cắm mạch, mở Serial Monitor 115200 (hoặc `screen /dev/cu.usbmodem* 115200`), rồi mở **VietMap Live -> Kết nối HUD -> `HUD(BLE)`**, chạy thử một đoạn đường và lưu toàn bộ log lại.
