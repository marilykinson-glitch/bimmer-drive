# Bimmer Drive (`Camera & VietMap` + `MGU Studio On-Demand`)

Kho ứng dụng thế hệ mới hợp nhất cụm hiển thị **Đồng hồ & HUD (KOMBI / HUD)** dành cho đầu **BMW MGU (iDrive 7)** trên **MGU Store**, được thiết kế lại từ gốc để **tối ưu tối đa CPU, RAM và băng thông SOME/IP** cho xe chạy mượt tuyệt đối.

---

## 1. Các thành phần trong kho (`mgu-repo.json`)

### 1.1. `Camera & VietMap` (`bimmer_drive` + trợ thủ `bimmer-drive` `1.0.1`)
Hợp nhất **3 ứng dụng & 3 dịch vụ chạy ngầm trước đây** (`Camera xi nhan` + `Biển báo VietMap` + `VietMap trên đồng hồ`) vào **1 ứng dụng giao diện 5 tab** và **1 dịch vụ gốc duy nhất**:

* **Camera gương theo xi nhan & Camera trước AR dẫn đường:**
  * Tự hiện camera gương Trái / Phải ngay trong vòng đồng hồ tốc độ / vòng tua khi bật xi nhan (hỗ trợ gạt nhẹ 3 nháy, tự dịu viền ban đêm, nhả tức thì khi vào số lùi `R`, khóa khoảng cách an toàn chống kẹt xi nhan).
  * Tự hiện Camera trước khi chạy chậm (`< 30` / `< 60 km/h` có trễ chống nhấp nháy bản đồ) hoặc khi sắp tới ngã rẽ dẫn đường kèm **mũi tên AR & tên đường tiếng Việt** (tương thích Bản đồ BMW, Apple CarPlay, Android Auto).
  * Hỗ trợ hiện đồng thời cả Camera trước và Camera gương lúc bật xi nhan ở ngã tư.
* **Biển báo tốc độ thông minh trên Đồng hồ, Camera trước & HUD:**
  * Tuỳ chọn 4 chế độ nguồn thông minh trong **Cài đặt -> Biển báo tốc độ**:
    1. **Tự động (mặc định):** Camera KAFAS BMW -> VietMap Live ĐT -> Bản đồ gốc BMW.
    2. **Ưu tiên VietMap ĐT -> BMW:** Ưu tiên biển tốc độ khu dân cư từ VietMap Live trên điện thoại, tự chuyển về Camera & Bản đồ BMW khi không nối điện thoại.
    3. **Chỉ VietMap từ điện thoại** hoặc **Chỉ nguyên bản BMW**.
  * Tự lọc bỏ mã `1` (`5 km/h` trong hầm xe / đường nội bộ) trên cả KAFAS và Bản đồ BMW.
  * Khi đoạn đường chưa có biển giới hạn: hiện **biển `---` (3 gạch ngang)** chuẩn nguyên bản BMW (hoặc tuỳ chọn ẩn).
  * Chớp sáng dịu nguyên bản khi xe chạy vượt quá giới hạn tốc độ.
* **Chiếu màn hình giữa lên đồng hồ (`VietMap Android Auto`):**
  * Bật/tắt 1 chạm ngay trong tab **Biển báo & AA** để chiếu bản đồ màn hình giữa lên vùng bản đồ đồng hồ & HUD (`Toàn bản đồ`, `Phóng gần`, `Phóng sát`); khi tắt tốn **0% CPU** và trả lại bản đồ đồng hồ gốc của điện thoại.
* **Mục `Cài đặt` tinh gọn chuẩn iDrive 7 (5 dòng duy nhất, không cần cuộn):**
  * Toàn bộ tuỳ chọn được gom thông minh thành **4 nhóm gọn gàng** (`Camera gương xi nhan`, `Camera trước & Mũi tên AR`, `Biển báo tốc độ`, `Tương thích phần cứng camera`) + `Màu giao diện`, tự ẩn các mục con không liên quan.

### 1.2. `MGU Studio` (`anh_dai_dien` + trợ thủ `anh-dai-dien` `1.0.1` — Chế độ Ngủ Đông 0 RAM)
* Đổi ảnh đại diện hồ sơ người lái, hình xe 3D/2D đúng màu sơn hãng và video màn hình khởi động từ điện thoại qua mã QR + PIN.
* **Cơ chế Ngủ Đông On-Demand:** Trợ thủ `anh-dai-dien.service` **không chạy ngầm 24/7** lúc lái xe (**0 MB RAM, 0% CPU, đóng cổng mạng `8137`**). Chỉ khi mở `MGU Studio` trên màn hình xe, `bimmer-drive` mới tự đánh thức trợ thủ trong `1–2 giây` và tự tắt sạch sau 10 phút không thao tác.

---

## 2. Tối ưu tài nguyên hệ thống so với bản rời trước đây

1. **Giảm 4 tiến trình Node.js chạy ngầm 24/7 xuống còn 1:** Hợp nhất `xinhan-cam.service`, `nav.js`, `vietmap-signs.service`, `vietmap-cluster.service` và tắt chạy thường trực `anh-dai-dien.service` -> giải phóng **~180 MB RAM** cho đầu MGU.
2. **Ngủ giải mã H.264 thông minh trong `mgu-sidecam` C++ (`1.0.1`):**
   * Khi đi thẳng không bật camera (`view = none`), bộ giải mã tự tắt bộ lọc khử khối H.264 (`AVDISCARD_ALL` loop filter) giúp giảm mạnh tải CPU nền mà vẫn giữ đủ mọi khung tham chiếu và nhận diện cặp SEI để khi gạt xi nhan hình lên **ngay trong `< 33 ms`**.
   * Ghép nửa khung thông minh (`Half-Frame Smart Pairing`) + đánh thức tức thì luồng `aux` khi chạy chế độ kép (Camera trước + Camera gương), giảm 50% băng thông đẩy khung thừa xuống đồng hồ KOMBI.
   * Tích hợp sẵn lệnh chụp nhanh 4 camera `960x720` (`{"op":"snap"}`).
3. **Giao tiếp Socket tức thời (`ctl.sock`):** Thay thế vòng lặp đọc file JSON mỗi `50 ms` bằng Unix Domain Socket sự kiện `< 1 ms`, kéo thả vị trí camera & biển tốc độ mượt trực tiếp trên đồng hồ thật và không gây hao mòn bộ nhớ Flash.

---

## 3. Hướng dẫn cài mới sạch trên xe (MGU Store)

1. Mở **MGU Store**, gỡ cài đặt các gói cũ rời rạc trước đây (nếu có):
   * Ứng dụng: `Camera xi nhan`, `Biển báo VietMap`, `VietMap trên đồng hồ`, `MGU Studio` bản cũ.
   * Công cụ (`Tools`): `xinhan-cam`, `vietmap-signs`, `vietmap-cluster`, `anh-dai-dien` bản cũ.
2. Thêm nguồn kho mới vào **MGU Store**:
   * `https://github.com/marilykinson-glitch/bimmer-drive`
3. Cài đặt **`Camera & VietMap`** (trợ thủ `bimmer-drive` sẽ tự động cài kèm) và **`MGU Studio`** (nếu cần đổi ảnh xe / màn khởi động).
4. Khởi động lại màn hình xe một lần sau khi cài để kích hoạt trọn vẹn.
   * Điện thoại Android vẫn dùng nguyên app **`Trình hỗ trợ VietMap Live` (`VietMapSigns.apk`)**: vào tab **`Biển báo & AA`** trên màn hình xe để xem mã ghép đôi 6 số (nếu xe từng ghép đôi bản cũ sẽ tự giữ lại mã cũ).
