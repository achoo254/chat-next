# ADR 0031: Chụp màn hình native trong tunelo (`tunelo-capture`), bản web giữ làm dự phòng

Trạng thái: **đã chấp nhận** (27/11/2026). Theo plan đã duyệt `plans/dattqh/261126-2215-screen-capture-record/`; đại ca chốt 27/11/2026
làm theo plan native và **giữ bản chụp/quay trên web** (đã lên prod cùng ngày) làm phương án dự phòng cho máy chưa cài `tunelo`.

## Bối cảnh

Chat không có app desktop (desktop là PWA, ADR 0013), nên trang web không đăng ký được phím tắt toàn cục, không vẽ được lớp chọn vùng đè lên
màn hình, và mỗi lần chụp đều phải qua hộp "Chọn nội dung chia sẻ" của trình duyệt. Muốn trải nghiệm kiểu Zalo (phím tắt, kéo vùng ngay trên
màn hình, chú thích) thì phải có một tiến trình chạy ở máy, và `tunelo` đã cài sẵn ở máy người dùng.

## Quyết định

- **Engine là tiến trình Rust `tunelo-capture`** (`apps/capture`), đóng gói cùng `tunelo` như `tunelo-term-host`. Windows trước; mã viết bằng thư viện
  đa nền tảng nên macOS và Linux sau này không phải đổi kiến trúc.
- **Lớp chọn vùng là ảnh đóng băng, không phải cửa sổ trong suốt**: chụp mọi màn hình trước, rồi mỗi màn hình một cửa sổ không viền, phủ kín, luôn
  trên cùng, hiển thị đúng ảnh vừa chụp ở độ phân giải gốc (như Snipaste, ShareX). Lý do: tránh lỗi cửa sổ trong suốt và lệch DPI khi nhiều màn hình
  khác tỷ lệ (125 %, 150 %), ảnh xuất ra đúng từng điểm ảnh người dùng thấy. Thay bước spike của plan (không có máy Windows có màn hình lúc làm);
  kiểm bằng mắt trên máy thật trước khi phát hành.
- **Thư viện**: `winit` (cửa sổ, vòng lặp sự kiện), `softbuffer` (đẩy điểm ảnh lên cửa sổ), `tiny-skia` (vẽ chú thích, xuất PNG), `xcap` (chụp màn hình),
  `global-hotkey` (phím tắt toàn cục), `arboard` (clipboard), `fontdue` (chữ, dùng font của hệ thống: Segoe UI trên Windows; không đóng kèm font).
- **Làm mờ là mosaic thật trên điểm ảnh gốc** (mỗi ô 12 px thay bằng màu trung bình), không phải lớp phủ: nội dung bị che không khôi phục được từ ảnh xuất.
- **IPC qua stdin/stdout của tiến trình con** (một đối tượng JSON mỗi dòng, `docs/capture-wire.md`), thay cho named pipe kèm token như plan ghi:
  `tunelo` khởi chạy `tunelo-capture`, chỉ tiến trình cha giữ hai đầu ống nên không cần token, đơn giản hơn mà an toàn như nhau. Ảnh không đi
  trên ống: mỗi ảnh là một tệp PNG trong thư mục `tunelo` chỉ định lúc khởi chạy; `tunelo` lo mã hoá lịch sử, tải lên và MCP.
- **Ảnh luôn được chép vào clipboard** khi người dùng bấm bất kỳ nút nào (Gửi, Thêm vào khay, Hỏi AI, Lưu, Sao chép), như Zalo.
- **Bản web (getDisplayMedia + chọn vùng trên trang) giữ lại**: nút trong ô soạn tin dùng `tunelo` khi máy đang mở trang có `tunelo` mới, ngược lại
  dùng bản web như hiện nay.

## Hệ quả

- CI có job `capture-windows` (fmt, clippy `-D warnings`, test, build release) trên `windows-2022`. Lớp phủ và phím tắt không tự động kiểm được trong CI;
  danh sách kiểm tay ở phase 1 của plan.
- Phần không cần màn hình (hình học vùng chọn, chú thích, xuất ảnh, bố cục thanh công cụ, giao thức) nằm trong thư viện và có test chạy ở mọi nền tảng.
- Một tiến trình nữa chạy nền cạnh `tunelo` khi bật chụp; tắt bằng cấu hình `capture.enabled=false` không ảnh hưởng tunnel, terminal, AI Agent.
- Chưa ký Authenticode (đại ca chốt ký sau): lần đầu Windows có thể cảnh báo SmartScreen/Defender; cách xử lý ghi ở `apps/agent/README.md` khi phát hành.
