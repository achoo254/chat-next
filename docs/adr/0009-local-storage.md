# ADR 0009: Lưu trữ local trên client

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14
- Huỷ 20/10/2026: desktop = PWA. Toàn hệ sinh thái không có app desktop native (Tauri); trên máy tính dùng bản web cài dạng PWA, đăng nhập bằng `chat-web`. Client `chat-desktop` đã gỡ khỏi IdP. SQLCipher chỉ còn trên mobile; PWA desktop theo chính sách của web. Phần nói về desktop/Tauri bên dưới chỉ còn là lịch sử.

## Bối cảnh

Client lưu tin nhắn, hội thoại, người dùng và chỉ mục tìm kiếm trong SQLite local để mở chat từ cache và tìm được khi offline. Đó là dữ liệu riêng tư nằm trên thiết bị người dùng. Điện thoại và máy tính có kho khoá của hệ điều hành; trình duyệt thì không có chỗ giữ khoá mà script cùng origin không đọc được. Một bản app mobile và desktop dùng cho mọi tenant, và một máy có thể đăng nhập nhiều tài khoản.

## Quyết định

- Mobile và desktop mã hoá DB local bằng SQLCipher:
  - Capacitor dùng `@capacitor-community/sqlite` build với SQLCipher; khoá nằm trong Keychain (iOS) hoặc Keystore (Android).
  - Tauri dùng SQLCipher qua `rusqlite`; khoá nằm trong OS keyring.
  - Bản build SQLCipher phải có FTS5; kiểm bằng `PRAGMA compile_options` trên từng nền tảng.
- Web không mã hoá DB local. SQLite trên OPFS chỉ là cache, bị xoá toàn bộ khi đăng xuất.
- Web mở được khi offline: service worker chỉ cache app shell của build (`index.html`, file build, icon, manifest), không bao giờ cache câu trả lời API hay media. Hồ sơ của người dùng lần chạy trước (`app:last-self` trong `localStorage`) chỉ được dùng để mở app khi không gọi được server và DB local vẫn là của đúng người đó; bị xoá khi đăng xuất hoặc khi server trả 401.
- Mọi dữ liệu local (DB, media cache, mục trong `SecureStore`) tách theo cặp `(tenant, user)`. Đổi tenant hay đổi tài khoản không bao giờ đọc chung dữ liệu.
- Nhận `SessionRevoked`, nhận 401 hoặc đăng xuất thì client xoá DB local, media cache và token của `(tenant, user)` đó.
- Cache tuân thủ quyền: khi chính người dùng bị gỡ khỏi chat (`member_removed`), khi tin bị xoá (`message_delete`) hoặc bị ẩn (`message_hidden`), client xoá bản ghi, dòng FTS và media cache tương ứng.
- Migration local dùng chung cho ba nền tảng qua interface `SqlDriver` có batch nguyên tử ([ADR 0007](./0007-client-topology.md)). Migration có version; khi không tương thích, client được phép reset DB local và đồng bộ lại.
- Media cache có trần dung lượng, trần thời gian và ngân sách riêng cho file lớn hoặc video, dọn theo LRU. Trần mặc định lấy từ `GetAppConfig`; người dùng chỉnh được trong cài đặt.
- Token phiên không nằm trong DB: web dùng cookie `HttpOnly`, native dùng `SecureStore` ([ADR 0006](./0006-sign-in-and-chat-sessions.md)).

## Lý do

- Trên thiết bị có kho khoá của hệ điều hành, SQLCipher bảo vệ dữ liệu khi máy bị mất hoặc file bị sao chép ra ngoài. Telegram Desktop cũng mã hoá mọi dữ liệu bền vững bằng khoá local.
- Trên web, khoá phải nằm ở nơi script cùng origin đọc được, nên mã hoá không chống được XSS mà chỉ thêm chi phí. Coi DB web là cache và xoá khi đăng xuất là giới hạn trung thực hơn.
- Tách theo `(tenant, user)` là điều kiện để một bản app phục vụ mọi tenant mà không lộ dữ liệu chéo.
- Purge theo quyền giữ lời hứa rằng rời chat hay bị kick thì không còn tìm được tin của chat đó, kể cả ở local.
- Telegram Desktop có trần dung lượng, trần thời gian và ngân sách riêng cho file lớn ở cache media; app này áp cùng cách để cache không chiếm hết đĩa.

## Hệ quả

- Extension thông báo trên mobile đọc được DB khi cần vì DB là SQLite native.
- Mất khoá trong kho khoá (ví dụ khôi phục máy không kèm Keychain) nghĩa là mất cache local; client tải lại từ server.
- Bị kick khi đang offline, mở app lại thì tin của chat đó biến khỏi kết quả tìm kiếm local sau khi đồng bộ.
- Quy tắc `stale` sau `too_long` ở [ADR 0002](./0002-sync.md) áp lên cùng DB này.

## Cách thay đổi

- Bật mã hoá cho web: thêm migration local chuyển DB sang dạng mã hoá; chỉ đáng làm khi trình duyệt có kho khoá mà script không đọc được.
- Đổi tham số mã hoá SQLCipher: cần migration rekey local trên từng thiết bị, chạy khi app mở.
- Đổi khoá tách dữ liệu (ví dụ thêm thiết bị vào khoá): đổi đường dẫn DB nghĩa là client bỏ cache cũ và đồng bộ lại, không mất dữ liệu trên server.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
