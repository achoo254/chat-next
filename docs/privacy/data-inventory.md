# Danh mục dữ liệu cá nhân của app chat

Dữ liệu cá nhân app chat giữ, ở đâu, giữ bao lâu và vì sao (Nghị định 13/2023/NĐ-CP). Bản đánh giá sơ bộ của nhóm phát triển, chưa phải ý kiến pháp lý. Nguồn đúng là schema (`server/migrations/`) và code: khi lệch, sửa file này. Cách xoá và xuất dữ liệu: package [`server/internal/privacy`](../../server/internal/privacy/privacy.go) và [`proto/app/v1/privacy.proto`](../../proto/app/v1/privacy.proto).

## IdP và app chat

| Bên | Giữ gì | Ai quản lý |
|---|---|---|
| IdP `hoandat-auth` | Danh tính Google/GitHub, email gốc, cách đăng nhập, grant của từng app | Người dùng ở `auth.<domain>/account`; xoá tài khoản hoandat ở đó |
| App chat | Mọi thứ trong bảng dưới, theo tenant (ADR 0010) | Người dùng trong app: Cài đặt > Tài khoản (xuất, tự xoá, xoá tài khoản chat) |

Xoá tài khoản chat không xoá tài khoản hoandat; nó thu hồi grant của app chat ở IdP. Đăng nhập lại sau khi xoá tạo một tài khoản chat mới, trống.

## Dữ liệu và thời hạn lưu

Cơ sở pháp lý: **HĐ** = thực hiện dịch vụ người dùng đăng ký dùng (Điều 17 NĐ 13, xử lý không cần đồng ý để thực hiện hợp đồng); **ĐY** = người dùng tự bật hoặc tự nhập (Điều 11, đồng ý); **NV** = nghĩa vụ an toàn, chống lạm dụng của nền tảng.

| Dữ liệu | Nơi lưu | Giữ bao lâu | Cơ sở |
|---|---|---|---|
| `idp_sub` (`acc_…`), username, tên, giới thiệu | `users` | Tới khi xoá tài khoản; khi xoá: username đổi thành `deleted_<id>`, tên/giới thiệu xoá, `idp_sub` xoá | HĐ |
| Email (bản sao từ IdP, chỉ khi đã xác minh) | `users.email` | Đọc lại mỗi lần đăng nhập/refresh; xoá khi IdP gỡ hoặc khi xoá tài khoản | HĐ; tìm theo email chỉ khi người dùng cho phép (ĐY) |
| Ảnh đại diện | Chưa có (RPC trả `unimplemented`) | | |
| Phiên chat: IP, user agent, thời điểm, `idp_sid` | `user_sessions` | Trượt 30 ngày, trần 90 ngày (web); xoá hẳn khi xoá tài khoản | HĐ, NV |
| Refresh token, ID token của IdP | `user_sessions` (mã hoá AES-GCM bằng `SESSION_KEY`) | Xoá khi phiên kết thúc; không bao giờ tới client | HĐ |
| Đăng ký Web Push (endpoint, khoá trình duyệt, ngôn ngữ) | `push_subscriptions` | Sống theo phiên; xoá khi phiên kết thúc | ĐY |
| Cài đặt quyền riêng tư, thông báo, tự xoá | `privacy_settings`, `notification_settings`, `users.auto_delete_months` | Tới khi xoá tài khoản | HĐ |
| Danh bạ, người đã chặn | `contacts`, `blocks` | Tới khi người dùng gỡ hoặc xoá tài khoản (cả hai chiều) | HĐ |
| Tin nhắn, cảm xúc, ghim, trạng thái đọc | `messages`, `message_reactions`, `chat_read_states`, `read_receipts` (7 ngày) | Tới khi thu hồi/xoá chat. Khi xoá tài khoản: tin gửi trong chat **của người khác** còn lại, người gửi hiện "Tài khoản đã xoá"; Cloud của tôi và chat riêng không còn ai giữ (bên kia là bot hoặc đã xoá) bị xoá | HĐ |
| File media (ảnh, video, file, voice) | `/opt/chat/media` + bảng `files` | Tới khi không còn tin nào dùng và không còn là ảnh đại diện, rồi thêm 1 ngày (dọn tự động) | HĐ |
| Ảnh đại diện của bot | `users.photo_file_id` (file trong bảng `files`, chủ bot tải lên ở Developer Console) | Tới khi chủ bot đổi hoặc xoá ảnh | HĐ |
| Log cập nhật đồng bộ | `user_updates`, `chat_updates`, `outbox` | Partition theo ngày, xoá sau 30 ngày; của người dùng bị xoá thì xoá ngay | HĐ |
| Bot của người dùng | `bots`, `users` (is_bot) | Dừng ngay khi bắt đầu xoá tài khoản, xoá cùng tài khoản | HĐ |
| Góp ý gửi trợ lý hoặc từ Cài đặt › Góp ý | `feedback` (trích tối đa 140 ký tự, đã che email và số điện thoại, đăng vào nhóm "Vận hành chat" của operator) | Tới khi xoá tài khoản | HĐ |
| Lỗi phía trình duyệt (loại, thông điệp đã che email, URL, số; vị trí trong mã app; bản build; tên màn hình) | `client_errors`, chỉ số đếm theo ngày, không gắn user | 90 ngày (dọn tự động) | NV |
| Inline query gửi bot (người hỏi, từ khoá, loại chat, câu trả lời của bot) | `bot_inline_queries` | 1 ngày (dọn tự động); kết quả và file của nó chỉ dùng được trong 1 giờ | HĐ (người dùng chủ động gõ @bot) |
| Gửi hàng loạt của bot (danh sách user id nhận, nội dung tin) | `bot_bulk_jobs` | 30 ngày sau khi job xong hoặc bị huỷ (dọn tự động); chỉ gửi cho người đã bắt đầu bot | ĐY (người nhận đã bắt đầu bot) |
| Báo cáo đã gửi, nhật ký kiểm duyệt | `reports`, `moderation_log` (chỉ thêm) | Giữ sau khi xoá tài khoản (người báo cáo thành tài khoản đã xoá) để xử lý khiếu nại | NV |
| Bản xuất dữ liệu (ZIP) | `/opt/chat/media/exports` (mặc định; `DATA_EXPORT_DIR`) + `data_exports` | 30 ngày sau khi xong; xoá ngay khi xoá tài khoản | HĐ |
| Bản sao lưu DB | `/opt/chat/backups` | 14 bản hằng ngày: dữ liệu đã xoá còn trong bản sao lưu tối đa 14 ngày | NV |
| Log ứng dụng, nginx | `/var/log/chat`, `/var/log/nginx` | Theo pm2-logrotate và logrotate của server; app chỉ ghi id, không ghi nội dung tin, email, token; mọi logger của server qua bộ lọc `server/internal/logging/redact` (che giá trị dưới khoá nhạy cảm và các dạng token, JWT, bot token, URL hook, `code=`/`state=`, email trong chữ) | NV |

## Quyền của người dùng

- **Xuất dữ liệu**: chạy nền, tải trong app (không email), giữ 30 ngày, mỗi 7 ngày một lần (lần lỗi không tính). ZIP gồm `profile.json`, `contacts.json`, `blocked.json`, `sessions.json`, `bots.json` (không token), `chats.json`, tin chính mình gửi theo từng chat (`messages/<chat>.json`, `chats/<chat>.html`), `index.html` xem offline và `media/` (file đính kèm tin mình gửi, tới 4 GB; phần vượt ghi `included: false`). Không có tin của người khác; người cùng chat chỉ xuất hiện qua tên và username. Link tải ký HMAC, sống 10 phút, trên host media.
- **Xoá tài khoản chat**: cần đăng nhập IdP trong 10 phút gần nhất và gõ username; bị chặn khi còn là chủ sở hữu nhóm/kênh. Xác nhận xong: mọi phiên kết thúc, grant IdP bị thu hồi, bot dừng, người khác thấy "Tài khoản đã xoá", không ai tìm hay nhắn được. 30 ngày sau dữ liệu bị xoá như bảng trên; trong 30 ngày đó đăng nhập lại chỉ có "Huỷ xoá tài khoản".
- **Tự xoá khi không dùng**: mặc định tắt; 6, 12 hoặc 24 tháng tính từ lần cuối có phiên được dùng. Đến hạn: như tự bấm xoá (cùng 30 ngày chờ), lần đăng nhập sau thấy lý do. Nếu người dùng là chủ nhóm/kênh, quyền chủ chuyển cho phó nhóm lâu nhất, không có thì thành viên lâu nhất; nhóm không còn ai thì bị xoá.

## Chuyển dữ liệu ra nước ngoài

Web Push đi qua dịch vụ push của trình duyệt (Google FCM, Mozilla, Microsoft, Apple; danh sách host trong [infrastructure-inventory.md](../infrastructure-inventory.md#ngoài-server)). Nội dung mã hoá theo từng trình duyệt (RFC 8291), dịch vụ push chỉ thấy endpoint, kích thước và thời điểm. Xem trước trong thông báo tắt được trong Cài đặt > Quyền riêng tư. Đánh giá tác động theo Điều 25 NĐ 13 (hồ sơ chuyển dữ liệu ra nước ngoài) còn phải làm trước khi mở công khai.
