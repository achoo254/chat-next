# ADR 0007: Topology client theo nền tảng

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14
- Huỷ 20/10/2026: desktop = PWA. Toàn hệ sinh thái không có app desktop native (Tauri); trên máy tính dùng bản web cài dạng PWA, đăng nhập bằng `chat-web`. Client `chat-desktop` đã gỡ khỏi IdP. Topology native chỉ còn Capacitor. Phần nói về desktop/Tauri bên dưới chỉ còn là lịch sử.

## Bối cảnh

Client dùng chung một lõi TypeScript (`packages/core`, `@achoo254/chat-core`) cho web, iOS/Android (Capacitor) và desktop (Tauri v2). Để mở chat từ cache trong p50 ≤ 50 ms và cuộn không giật, main thread phải rảnh cho việc vẽ. Trên web, cách của các client nhanh là đưa kết nối, giải mã và lưu trữ vào worker. Trên native, plugin Capacitor và lệnh `invoke` của Tauri không gọi được từ Web Worker, nên "mọi thứ trong worker" chỉ đúng với web.

## Quyết định

- Web: một worker sở hữu transport WebSocket, sync engine, SQLite trên OPFS (`opfs-sahpool`) và tìm kiếm local. Main thread chỉ chạy React. Không có thao tác DB hay giải mã protobuf trên main thread.
- Web nhiều tab: một tab giữ DB qua Web Locks; tab khác gọi qua tab đó. Tab giữ DB đóng thì tab còn lại tiếp quản.
- Capacitor và Tauri: sync engine và transport chạy trên main thread. Mọi thao tác nặng (ghi SQL theo lô, giải mã protobuf lô lớn) được đẩy xuống native qua một lời gọi batch cho mỗi lô update.
- Ở cả hai topology, UI chỉ nhận thay đổi đã gom theo frame, qua event bus theo id (hội thoại, khoá tin nhắn).
- Điểm nối nền tảng là `startApp(platform)`, nhận các interface `SqlDriver` (batch nguyên tử), `Push`, `Lifecycle`, `Notify`, `Badge`, `Files`, `SecureStore`, `OpenExternal` và `AuthBrowser`. Mỗi nền tảng có một package hiện thực riêng.
- Vòng đời kết nối:
  - Mobile không giữ WebSocket khi chạy nền; dựa vào push, khi resume thì kết nối lại và gọi `GetDifference`.
  - Desktop giữ WebSocket khi thu nhỏ; khi thức dậy từ sleep thì gọi `GetDifference`. Nếu cửa sổ ẩn bị throttle, phương án dự phòng là chuyển WebSocket và thông báo xuống Rust.
- Chi tiết của nhánh native được chốt bằng spike trên thiết bị thật trước khi đóng interface của `@achoo254/chat-core`: ghi một lô 1.000 tin phải chặn main thread dưới 16 ms trên thiết bị tham chiếu (Android tầm trung, iPhone cũ, Windows). Không đạt thì chuyển thêm logic xuống native trước khi làm UI.

## Lý do

- Client web của Telegram giữ main thread rảnh bằng cách chạy kết nối, giải mã và sắp xếp update trong worker; SQLite trên OPFS cho phép làm điều đó với một DB có giao dịch và FTS5.
- Plugin native không gọi được từ Worker, nên trên native, sync chạy trong worker vẫn phải nhờ main thread chuyển tiếp mọi thao tác DB; chạy thẳng trên main thread và đẩy phần nặng xuống native đơn giản hơn.
- Gom thành một lời gọi batch giữ chi phí bridge cố định theo lô thay vì theo từng tin.
- Gom thay đổi theo frame tránh render lại nhiều lần trong một frame khi một lô update tới.
- Một tập interface nền tảng cho phép lõi sync, outbox và tìm kiếm viết một lần.

## Hệ quả

- `@achoo254/chat-core` không phụ thuộc React và không gọi trực tiếp API của nền tảng; mọi truy cập đi qua interface ở trên.
- Ngân sách mở chat từ cache đo trên web; ngân sách native đo riêng trên thiết bị.
- OPFS còn hạn chế trên Safari; đây là rủi ro đã biết của driver web.
- Desktop phụ thuộc cách hệ điều hành throttle WebView ẩn; đây là rủi ro lớn nhất của client desktop.
- Cách lưu dữ liệu local và mã hoá thuộc [ADR 0009](./0009-local-storage.md); thứ tự đồng bộ thuộc [ADR 0002](./0002-sync.md).

## Cách thay đổi

- Kết quả spike native có thể đổi ranh giới giữa main thread và native (ví dụ chuyển giải mã protobuf xuống native). Thay đổi đó nằm trong hiện thực của `SqlDriver` và package nền tảng, không đổi interface với UI.
- Chuyển transport desktop xuống Rust là thay đổi trong package Tauri; sync engine nhận update qua cùng interface.
- Đổi interface nền tảng cần sửa đồng thời cả ba package hiện thực; vì `@achoo254/chat-core` là gói nội bộ (chỉ phát hành gộp trong `@achoo254/chat-client`), không có client bên thứ ba bị ảnh hưởng.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
