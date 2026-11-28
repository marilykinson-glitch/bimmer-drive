# Cầu nối Virtual VietMap HUD (`HUD(BLE)`) dùng ESP32-C6 / ESP32-C3 / ESP32-S3

Firmware gọn nhẹ biến một mạch **ESP32-C6 SuperMini** (hoặc ESP32-C3 / ESP32-S3 / ESP32 thường, giá ~50–80k) thành thiết bị giả lập **`HUD(BLE)`** chính chủ của VietMap Live — **cắm thẳng cổng USB trên xe BMW MGU** làm cầu truyền dữ liệu tốc độ sang `bimmer-drive` (không cần mở màn hình điện thoại, không cần Wi-Fi hotspot).

> Khi nào cần dùng ESP32?
> * Dịch vụ `bimmer-drive` sẽ **tự động thử phát sóng BLE trực tiếp bằng Bluetooth của xe BMW (`dbus-bluez-hud.js`)** trước tiên.
> * Nếu BMW khóa BlueZ D-Bus GATT Server hoặc không cấp quyền advertise BLE, bạn chỉ cần cắm mạch ESP32 nhỏ bằng ngón tay này vào cổng USB dữ liệu trong hộc tì tay: `bimmer-drive` tự nhận diện `/dev/ttyACM0` hoặc `/dev/ttyUSB0` ngay lập tức!

## Cách nhanh: nạp thẳng file `.bin` (không cần Arduino IDE)
File `.bin` gộp sẵn bootloader + phân vùng + firmware, nạp ở địa chỉ `0x0`. File không nằm trong kho (S3 nặng 16MB); tự tạo bằng `arduino-cli` (bộ `esp32` 3.3.x), kết quả là `out/vm_hud_esp32.ino.merged.bin`:

```bash
mkdir -p /tmp/vm_hud_esp32 && cp vm_hud_esp32.ino /tmp/vm_hud_esp32/
arduino-cli compile -b esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB --output-dir out /tmp/vm_hud_esp32
arduino-cli compile -b esp32:esp32:esp32c6:CDCOnBoot=cdc --output-dir out-c6 /tmp/vm_hud_esp32
```


| Mạch | File |
|---|---|
| ESP32-C6 SuperMini | `vm_hud_esp32c6.merged.bin` |
| ESP32-S3 (flash 16MB) | `vm_hud_esp32s3.merged.bin` |

* **Trên trình duyệt Chrome/Edge:** mở https://espressif.github.io/esptool-js/ -> **Connect** -> chọn cổng của mạch -> Flash Address `0x0`, chọn file `.bin` -> **Program**.
* **Bằng `esptool`:**
  ```bash
  pip install esptool
  esptool --chip esp32c6 write-flash 0x0 vm_hud_esp32c6.merged.bin
  ```
  (S3: `--chip esp32s3` và file `vm_hud_esp32s3.merged.bin`.)
* Không nhận cổng / nạp lỗi: giữ **BOOT**, bấm **RST**, nhả BOOT rồi nạp lại. Nạp xong bấm **RST** một lần.

## Cách nạp firmware bằng Arduino IDE
1. Cài **Arduino IDE** + Board Manager **`esp32` by Espressif Systems** (bản 2.x hoặc 3.x).
2. Chọn board:
   * **ESP32-C6 SuperMini:** `ESP32C6 Dev Module`, bật **USB CDC On Boot: Enabled** (cần Arduino-ESP32 **3.x**, khuyên 3.1 trở lên).
   * ESP32-C3 SuperMini: `ESP32C3 Dev Module`, cũng bật **USB CDC On Boot: Enabled**.
   * Nếu không nạp được: giữ nút **BOOT**, bấm **RST**, nhả BOOT rồi bấm Upload.
3. Mở file [`vm_hud_esp32.ino`](./vm_hud_esp32.ino) -> bấm **Upload**.
4. Cắm mạch vào cổng USB trên xe (hoặc test thử trên máy tính), mở **VietMap Live -> Kết nối HUD**, chọn thiết bị **`vietmap_V3`** (mạch phát tên `vietmap-HUD_V3(BLE)`, app hiển thị rút gọn).

## Định dạng dữ liệu qua USB Serial (115200 baud)
```json
{"t":"vmhud","v":1,"limit":60,"next":50,"dist":200,"camType":1,"connected":true,"model":"H1N"}
```
`bimmer-drive` tự động đọc dòng JSON này từ `/dev/ttyACM*` / `/dev/ttyUSB*`, cập nhật biển P.127 trên đồng hồ + kính lái HUD ngay lập tức mà không cần nhập mã ghép đôi 6 số.

## Nhật ký byte thô trên xe
Từ `bimmer-drive` 1.1.3, các dòng `"t":"raw"` được lọc gọn (bỏ ảnh, bỏ gói lặp) và ghi vào `/var/opt/bimmer-drive/vmhud-raw.log` (tối đa 256KB + 1 file cũ). Xem nhanh bằng công cụ **Nhật ký Camera & VietMap** trong MGU Store, mục `VIETMAP HUD RAW`. Mỗi dòng: `giờ rx <mã lệnh> <nội dung hex>`; lệnh `01` là gói biển báo/camera.

## Thử với VietMap Live trước khi ra xe (chế độ `RAW_LOG`)
Firmware mặc định bật `RAW_LOG 1`: ngoài dòng `vmhud`, còn in mọi byte VietMap gửi (`"dir":"rx"`) và ESP32 trả lời (`"dir":"tx"`). `bimmer-drive` tự bỏ qua các dòng `"t":"raw"`.

Trên Mac: cắm mạch, mở Serial Monitor 115200 (hoặc `screen /dev/cu.usbmodem* 115200`), rồi mở **VietMap Live -> Kết nối HUD -> `vietmap_V3`**, chạy thử một đoạn đường và lưu toàn bộ log lại.

## Vì sao tên phát sóng là `vietmap-HUD_V3(BLE)`
Đo trực tiếp với VietMap Live 3.4.5 trên Android (log `adb logcat` + log byte thô của mạch):

| Tên phát sóng | App liệt kê? | App kết nối kiểu gì |
|---|---|---|
| `HUD(BLE)`, `HUD_V3(BLE)`, `HUD-1234`, `HUD_1234`, `vmHUD` | Không | — |
| `vietmap-hud`, `vietmap-hud(BLE)` | Có | Bluetooth thường (SPP) -> ESP32-S3/C3/C6 không có -> `PAGE_TIMEOUT`, nhảy liên tục |
| `vietmap-HUD_V3(BLE)` | Có (hiện là `vietmap_V3`) | **BLE GATT** `FFF0`/`FFF1`/`FFF2` -> kết nối ổn định |

Đổi tên không cần nạp lại: gửi dòng `name=<tên mới>` qua USB Serial (115200), mạch lưu vào flash rồi tự khởi động lại; `name=` để về mặc định.
