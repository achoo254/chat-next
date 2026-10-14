# ADR 0003: Outbox giao việc sau commit

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14

## Bối cảnh

Mỗi thay đổi dữ liệu (tin mới, sửa, xoá, thành viên rời chat, phiên bị thu hồi) phải tới nhiều nơi: gateway realtime, push, chỉ mục tìm kiếm, update của bot, incoming webhook. Gửi thẳng từ handler thì mất việc khi process chết giữa chừng; một hàng đợi dùng chung không có cursor thì các consumer giẫm lên nhau, mất thứ tự và không biết khi nào được dọn. Ngân sách tốc độ (người nhận online thấy tin p50 ≤ 150 ms) không cho phép chờ một vòng polling.

## Quyết định

- Bảng `outbox` là một log có `id` tăng dần. Mọi mutation ghi một dòng outbox trong cùng transaction với dữ liệu mà nó mô tả.
- `outbox` được partition theo thời gian, mỗi ngày một partition. Một job tạo partition trước và xoá cả partition cũ hơn 30 ngày, không xoá từng dòng. 30 ngày bằng thời hạn của update log phía client, đủ dài hơn độ trễ của consumer chậm nhất kể cả khi dựng lại chỉ mục tìm kiếm hay sau một sự cố.
- `kind` là enum đầy đủ:

| `kind` | Sự kiện |
|---|---|
| `message_new` | Tin mới |
| `message_edit` | Sửa tin |
| `message_delete` | Xoá tin cho mọi người |
| `message_hidden` | Ẩn tin cho riêng một người |
| `reaction` | Reaction thay đổi |
| `read` | Đánh dấu đã đọc |
| `pin` | Ghim hoặc bỏ ghim |
| `member_added` | Thêm thành viên |
| `member_removed` | Thành viên rời chat hoặc bị kick |
| `member_permissions` | Đổi quyền hoặc vai trò thành viên |
| `chat_mode_changed` | Chat chuyển `sync_mode` từ `small` sang `large` |
| `chat_updated` | Đổi thông tin chat |
| `inline_button` | Người dùng bấm nút inline của bot |
| `session_revoked` | Phiên chat bị thu hồi |

- Mỗi consumer giữ cursor riêng trong `outbox_cursors` và tiến độc lập với consumer khác.
- Consumer cần thứ tự thì shard theo khoá thứ tự của nó: chỉ mục tìm kiếm shard theo `chat_id`, consumer của bot shard theo `bot_id` để mỗi bot chỉ có một writer cấp `update_id`.
- Giao việc hai lớp:
  - Ngay sau commit, hook `afterCommit` đẩy việc thẳng vào dispatcher trong cùng process (realtime, push, bot, webhook).
  - Sweeper chạy mỗi 200 ms, dùng `FOR UPDATE SKIP LOCKED` trong phạm vi shard của consumer, chỉ nhặt việc bị rơi. Sweeper là lưới an toàn, không phải đường chính.
- Không dùng `LISTEN/NOTIFY` cho từng tin.
- Khi cần scale, outbox được relay sang NATS JetStream mà giữ nguyên contract `kind` và cursor.

## Lý do

- Ghi outbox trong cùng transaction bảo đảm không có sự kiện nào được ack mà không có việc giao tương ứng, và không có việc giao nào cho dữ liệu đã rollback.
- `afterCommit` cho độ trễ gần bằng gọi trực tiếp; sweeper che các trường hợp process chết giữa commit và dispatch.
- Cursor theo consumer cho phép thêm consumer mới (ví dụ chỉ mục tìm kiếm) và cho mỗi consumer tự chậm hoặc tự chạy lại mà không ảnh hưởng consumer khác.
- Shard theo `chat_id` giữ thứ tự sửa và xoá của cùng một tin trong chỉ mục; shard theo `bot_id` cho `update_id` tăng liên tục mà không tranh khoá, và tránh biến bot thành dòng nóng trong `user_state`.
- Xoá theo partition rẻ và không làm phình bảng như `DELETE` hàng loạt.
- `LISTEN/NOTIFY` theo từng tin không mở rộng được khi lưu lượng lớn.

## Hệ quả

- Việc giao là ít nhất một lần: consumer phải idempotent. Chỉ mục tìm kiếm so `edit_version` để bỏ bản ghi cũ.
- Mọi tính năng mới có ghi dữ liệu phải chọn một `kind` có sẵn hoặc thêm `kind` mới; không có đường ghi nào bỏ qua outbox.
- `session_revoked` đi qua outbox để gateway đóng socket trong ≤ 1 s, xem [ADR 0006](./0006-sign-in-and-chat-sessions.md).
- Incoming webhook tự tắt khi người tạo mất quyền admin hoặc rời chat, nhờ đọc `member_permissions` và `member_removed`.
- Update trong nhật ký đồng bộ của người dùng ([ADR 0002](./0002-sync.md)) và dòng outbox là hai thứ khác nhau: nhật ký phục vụ client bắt kịp, outbox phục vụ việc giao phía server.
- Partition outbox được giữ 30 ngày. Consumer nào tụt quá 30 ngày thì mất việc, nên cảnh báo độ trễ cursor phải báo từ rất sớm (tính bằng phút, không phải ngày).

## Cách thay đổi

- Thêm `kind`: thêm giá trị enum, ghi dòng outbox ở mutation mới, rồi cập nhật các consumer cần nó. Trước khi bật, kiểm mọi consumer hiện có bỏ qua `kind` mà nó không xử lý.
- Đổi tên hoặc bỏ `kind`: chờ mọi consumer đi qua các dòng còn mang `kind` cũ, rồi mới đổi enum.
- Đổi khoá shard của một consumer: dừng consumer đó, chờ cursor bắt kịp đầu log, đổi shard rồi chạy lại.
- Chuyển sang NATS JetStream: thêm relay đọc outbox theo cursor riêng; các consumer chuyển dần sang đọc từ NATS mà không đổi `kind`.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
