# Cầu nối Virtual VietMap HUD (`HUD(BLE)`) dùng ESP32-C3 / ESP32

Firmware gọn nhẹ biến một mạch **ESP32-C3** (hoặc ESP32 thường / ESP32-S3, giá ~50–80k) thành thiết bị giả lập **`HUD(BLE)`** chính chủ của VietMap Live — **cắm thẳng cổng USB trên xe BMW MGU** làm cầu truyền dữ liệu tốc độ sang `bimmer-drive` (không cần mở màn hình điện thoại, không cần Wi-Fi hotspot).

> Khi nào cần dùng ESP32?
> * Dịch vụ `bimmer-drive` sẽ **tự động thử phát sóng BLE trực tiếp bằng Bluetooth của xe BMW (`dbus-bluez-hud.js`)** trước tiên.
> * Nếu BMW khóa BlueZ D-Bus GATT Server hoặc không cấp quyền advertise BLE, bạn chỉ cần cắm mạch ESP32 nhỏ bằng ngón tay này vào cổng USB dữ liệu trong hộc tì tay: `bimmer-drive` tự nhận diện `/dev/ttyACM0` hoặc `/dev/ttyUSB0` ngay lập tức!

## Cách nạp firmware bằng Arduino IDE
1. Cài **Arduino IDE** + Board Manager **`esp32` by Espressif Systems** (bản 2.x hoặc 3.x).
2. Chọn board tương ứng (ví dụ `ESP32C3 Dev Module` — nhớ bật **USB CDC On Boot: Enabled** nếu dùng mạch SuperMini ESP32-C3 để Serial USB xuất ra `/dev/ttyACM0`).
3. Mở file [`vm_hud_esp32.ino`](./vm_hud_esp32.ino) -> bấm **Upload**.
4. Cắm mạch vào cổng USB trên xe (hoặc test thử trên máy tính), mở **VietMap Live -> Kết nối HUD**, chọn **`HUD(BLE)`**.

## Định dạng dữ liệu qua USB Serial (115200 baud)
```json
{"t":"vmhud","v":1,"limit":60,"next":50,"dist":200,"camType":1,"connected":true,"model":"H1N"}
```
`bimmer-drive` tự động đọc dòng JSON này từ `/dev/ttyACM*` / `/dev/ttyUSB*`, cập nhật biển P.127 trên đồng hồ + kính lái HUD ngay lập tức mà không cần nhập mã ghép đôi 6 số.
