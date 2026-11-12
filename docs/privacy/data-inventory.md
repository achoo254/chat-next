# Danh mục dữ liệu cá nhân của app chat

Dữ liệu cá nhân app chat giữ, ở đâu, giữ bao lâu và vì sao (Nghị định 13/2023/NĐ-CP). Bản đánh giá sơ bộ của nhóm phát triển, chưa phải ý kiến pháp lý. Nguồn đúng là schema (`server/migrations/`) và code: khi lệch, sửa file này. Cách xoá và xuất dữ liệu: package [`server/internal/privacy`](../../server/internal/privacy/privacy.go) và [`proto/app/v1/privacy.proto`](../../proto/app/v1/privacy.proto).

## IdP và app chat

| Bên | Giữ gì | Ai quản lý |
|---|---|---|
| IdP `auth-next` | Danh tính Google/GitHub/Apple, email gốc, cách đăng nhập, grant của từng app | Người dùng ở `auth.<domain>/account`; xoá tài khoản hoandat.com ở đó |
| App chat | Mọi thứ trong bảng dưới | Người dùng trong app: Cài đặt > Tài khoản (xuất, tự xoá, xoá tài khoản chat) |

Xoá tài khoản chat không xoá tài khoản hoandat.com; nó thu hồi grant của app chat ở IdP. Đăng nhập lại sau khi xoá tạo một tài khoản chat mới, trống.

## Dữ liệu và thời hạn lưu

Cơ sở pháp lý: **HĐ** = thực hiện dịch vụ người dùng đăng ký dùng (Điều 17 NĐ 13, xử lý không cần đồng ý để thực hiện hợp đồng); **ĐY** = người dùng tự bật hoặc tự nhập (Điều 11, đồng ý); **NV** = nghĩa vụ an toàn, chống lạm dụng của nền tảng.

| Dữ liệu | Nơi lưu | Giữ bao lâu | Cơ sở |
|---|---|---|---|
| `idp_sub` (`acc_…`), username, tên, giới thiệu | `users` | Tới khi xoá tài khoản; khi xoá: username đổi thành `deleted_<id>`, tên/giới thiệu xoá, `idp_sub` xoá | HĐ |
| Email (bản sao từ IdP, chỉ khi đã xác minh) | `users.email` | Đọc lại mỗi lần đăng nhập/refresh; xoá khi IdP gỡ hoặc khi xoá tài khoản | HĐ; tìm theo email chỉ khi người dùng cho phép (ĐY) |
| Ảnh đại diện người dùng tự tải lên | `users.photo_file_id` (file ở kho media) | Tới khi người dùng gỡ ảnh hoặc xoá tài khoản; ai thấy theo Cài đặt › Quyền riêng tư | ĐY |
| Đường dẫn ảnh tài khoản IdP (claim `picture` của scope `profile`: ảnh Google/GitHub, chỉ URL `https`) | `users.idp_picture` | Đọc lại mỗi lần đăng nhập/refresh; xoá khi IdP gỡ hoặc khi xoá tài khoản; chỉ trả cho chính người dùng (`User.idp_picture` ở `GetSelf`), có trong `profile.json` của bản xuất | HĐ |
| Phiên chat: IP, user agent, thời điểm, `idp_sid`; với app iOS/Android thêm nền tảng, tên thiết bị chung ("iPhone", "iPad", "Android") và phiên bản app | `user_sessions` | Trượt 30 ngày, trần 90 ngày (web; app không có trần); xoá hẳn khi xoá tài khoản | HĐ, NV |
| Token phiên của app iOS/Android | Keychain (chỉ thiết bị này) hoặc Keystore của máy; server chỉ giữ hash | Xoá khi đăng xuất, phiên bị thu hồi hoặc hết hạn | HĐ |
| Refresh token, ID token của IdP | `user_sessions` (mã hoá AES-GCM bằng `SESSION_KEY`) | Xoá khi phiên kết thúc; không bao giờ tới client | HĐ |
| Đăng ký Web Push (endpoint, khoá trình duyệt, ngôn ngữ) | `push_subscriptions` | Sống theo phiên; xoá khi phiên kết thúc | ĐY |
| Máy của tôi: tên máy, hệ điều hành, phiên bản `tunelo` và `claude`, khoá công khai của máy, địa chỉ tunnel, lần thấy cuối; id grant `tunelo-agent` ở IdP đã đăng ký máy và lúc grant đó được thu hồi | `machines` | Tới khi người dùng xoá máy (dòng giữ cờ thu hồi để báo máy dừng và để thu hồi grant ở IdP) hoặc xoá tài khoản (xoá hẳn). Server không thấy nội dung giữa thiết bị và máy (ADR 0013) | ĐY |
| Thiết bị của tài khoản (trình duyệt, app): khoá công khai của thiết bị, tên do app đặt (trình duyệt + hệ điều hành, hoặc tên app), nền tảng, lúc thêm, lần mở máy cuối, lúc thu hồi; phiên chat đã đăng ký khoá | `account_devices` | Tới khi xoá tài khoản (xoá hẳn). Thu hồi (bởi người dùng, hoặc tự động khi phiên đăng ký nó kết thúc) chỉ đặt lúc thu hồi và giữ dòng, để khoá đó không bao giờ đăng ký lại được. Máy của chính người dùng nhận danh sách khoá sống (khoá, tên, nền tảng, lúc thêm) qua heartbeat và lưu trong `config.json` của nó (ADR 0013) | ĐY (người dùng mở khu Máy) |
| Bản ghi cũ từ thời ghép thiết bị: khoá công khai thiết bị đã thu hồi theo máy, hash mã cài | `machine_revoked_devices`, `machine_install_codes` | Không còn được ghi; dòng cũ xoá hẳn khi xoá tài khoản, và cả hai bảng bị bỏ ở lần dọn schema sau tunelo 3.0 | ĐY |
| Ngôn ngữ app đang hiện (`vi`, `en`, `zh-CN`), để bot Trợ lý nhắn đúng ngôn ngữ | `users.locale` | App gửi lại mỗi lần mở và khi đổi ngôn ngữ (`UsersService.SetLocale`); tới khi xoá tài khoản (dòng của tài khoản đã xoá còn giữ giá trị này, không định danh được ai); có trong `profile.json` của bản xuất (`locale`) | HĐ |
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

## Sổ số liệu AI trên máy của người dùng

Agent `tunelo` đọc transcript của AI cài trên máy (Claude Code: `<thư mục Claude>/projects/**/*.jsonl`, kể cả `subagents/`) và ghi **số liệu** vào sổ trên chính máy đó ([`apps/agent/src/usage/`](../../apps/agent/src/usage/ledger.ts)). Server chat không nhận gì từ sổ. Sổ không chứa nội dung tin nhắn, nội dung lệnh hay tham số tool (trừ tên skill của tool Skill), kết quả tool; bộ đọc bước qua các phần đó mà không giải mã.

| Dữ liệu | Nơi lưu | Giữ bao lâu | Cơ sở |
|---|---|---|---|
| Mỗi lời gọi API của AI: khoá của lời gọi (id tin trả lời và id request của nhà cung cấp), id phiên, id subagent (nếu có), thời điểm, tên model, 4 loại token (input, cache đọc, cache ghi, output), thư mục làm việc của lời gọi, tên các tool đã gọi (kể cả tên tool MCP, dạng `mcp__<server>__<tool>`; với tool Skill thêm tên skill) | Một file mỗi tháng theo giờ máy: `<thư mục config tunelo>/usage/ledger/YYYY-MM.json` (quyền 0600, thư mục 0700) và bản sao `YYYY-MM.prev.json` trước mỗi lần ghi; một lượt quét chỉ ghi lại tháng nó thêm số liệu | Không tự hết hạn (transcript gốc bị AI tự xoá sau khoảng 30 ngày, sổ là bản còn lại); xoá bằng nút xoá trên thiết bị của tài khoản | ĐY (người dùng cài agent trên máy của mình) |
| Mỗi thư mục làm việc gặp lần đầu: đường dẫn → remote `origin` của repo chứa nó (đọc từ file cấu hình git, bỏ user và mật khẩu của remote https; worktree đi về repo gốc), hoặc `local:<tên thư mục>`, hoặc `scratch` cho thư mục tạm; thời điểm ghi | Mục lục của sổ: `<thư mục config tunelo>/usage/index.json` (0600) và bản sao `index.prev.json` trước mỗi lần ghi | Như trên | ĐY |
| Mỗi file transcript đã đọc: đường dẫn, thiết bị và inode, kích thước, thời điểm sửa, vị trí đã đọc tới | Mục lục của sổ | Bỏ khi file không còn trên máy (số liệu của nó vẫn giữ) | ĐY |
| Id phiên AI do agent mở (luồng chat, resume, terminal của app), thời điểm thấy lần đầu | Mục lục của sổ | Như dòng đầu | ĐY |
| Mức dùng gói của từng profile Claude (id profile, % cửa sổ 5 giờ và 7 ngày, thời điểm đặt lại, đánh dấu "theo lịch" hay "do người dùng") | Mục lục của sổ | Như dòng đầu | ĐY |
| Gợi ý đã gửi: id nhà cung cấp, id phiên, mã luật (`context`, `turns`, `mechanical`, `subagents`), thời điểm gửi | Mục lục của sổ | Như dòng đầu | ĐY |
| Kiểm tra định dạng: số bản ghi trả lời có và không có token theo ngày (giữ 60 ngày), loại nội dung lạ (chỉ tên loại), số dòng lỗi, `schemaVersion`, thời điểm quét cuối | Mục lục của sổ | Như dòng đầu | ĐY |
| Công tắc bật/tắt từng luật gợi ý (chỉ mã luật và bật/tắt) | `<thư mục config tunelo>/config.json`, trường `usageRules` | Tới khi người dùng đổi | ĐY |

Sổ không rời máy. Báo cáo theo khoảng ngày và gợi ý cho phiên đang chạy chỉ tới thiết bị của chính người dùng qua kênh mã hoá đầu cuối giữa thiết bị và máy, và chỉ gồm số, mã luật, id phiên, khoá repo và ngày: không nội dung tin nhắn, không tiêu đề, không đường dẫn file hay thư mục, không tên model hay tên tool. Khi có gợi ý, agent còn xin server chat một thông báo đẩy không nội dung (chỉ loại "gợi ý dùng AI" và tên máy, giống thông báo "cần bạn"): lời gọi không mang id phiên, mã luật hay con số nào. Bật/tắt luật và xoá sổ từ thiết bị được ghi vào nhật ký đồng ý (`usage_rules` với mã luật và bật/tắt, `usage_delete`).

Agent không ghi đè một file của sổ (mục lục hoặc file tháng) nó không đọc được hoặc do bản agent mới hơn ghi (`schemaVersion` lạ): sổ giữ nguyên tới khi người dùng xoá. Sổ một file của bản đầu (`usage/ledger.json`) được tách thành file tháng ở lần chạy đầu: ghi vào thư mục riêng, đọc lại so từng token, chuyển vào chỗ, ghi mục lục, rồi mới xoá file cũ; file cũ không đọc được thì giữ nguyên.

## Mức cấu hình dự án trên máy của người dùng

Agent `tunelo` giữ, cho mỗi thư mục người dùng bật hay tắt cấu hình `.claude` của dự án từ thiết bị của tài khoản, đường dẫn thư mục và mức (`full`/`off`) trong `<thư mục config tunelo>/data/project-config.json` (quyền 0600) trên chính máy đó, tới khi người dùng đổi; server chat không nhận gì. Mỗi lần đổi được ghi vào nhật ký đồng ý trên máy (`project_settings`: thiết bị, thời điểm, thư mục, `level:full`/`level:off`). Thiết bị của tài khoản thấy mức của thư mục và của từng phiên qua kênh mã hoá đầu cuối.

## Quyền của người dùng

- **Xuất dữ liệu**: chạy nền, tải trong app (không email), giữ 30 ngày, mỗi 7 ngày một lần (lần lỗi không tính). ZIP gồm `profile.json`, `contacts.json`, `blocked.json`, `sessions.json`, `bots.json` (không token), `chats.json`, tin chính mình gửi theo từng chat (`messages/<chat>.json`, `chats/<chat>.html`), `index.html` xem offline và `media/` (file đính kèm tin mình gửi, tới 4 GB; phần vượt ghi `included: false`). Không có tin của người khác; người cùng chat chỉ xuất hiện qua tên và username. Link tải ký HMAC, sống 10 phút, trên host media.
- **Xoá tài khoản chat**: cần đăng nhập IdP trong 10 phút gần nhất và gõ username; bị chặn khi còn là chủ sở hữu nhóm/kênh. Xác nhận xong: mọi phiên kết thúc, grant IdP bị thu hồi, bot dừng, người khác thấy "Tài khoản đã xoá", không ai tìm hay nhắn được. 30 ngày sau dữ liệu bị xoá như bảng trên; trong 30 ngày đó đăng nhập lại chỉ có "Huỷ xoá tài khoản".
- **Tự xoá khi không dùng**: mặc định tắt; 6, 12 hoặc 24 tháng tính từ lần cuối có phiên được dùng. Đến hạn: như tự bấm xoá (cùng 30 ngày chờ), lần đăng nhập sau thấy lý do. Nếu người dùng là chủ nhóm/kênh, quyền chủ chuyển cho phó nhóm lâu nhất, không có thì thành viên lâu nhất; nhóm không còn ai thì bị xoá.

## Chuyển dữ liệu ra nước ngoài

Web Push đi qua dịch vụ push của trình duyệt (Google FCM, Mozilla, Microsoft, Apple; danh sách host trong [infrastructure-inventory.md](../infrastructure-inventory.md#ngoài-server)). Nội dung mã hoá theo từng trình duyệt (RFC 8291), dịch vụ push chỉ thấy endpoint, kích thước và thời điểm. Xem trước trong thông báo tắt được trong Cài đặt > Quyền riêng tư. Đánh giá tác động theo Điều 25 NĐ 13 (hồ sơ chuyển dữ liệu ra nước ngoài) còn phải làm trước khi mở công khai.

Công cụ AI người dùng tự kết nối qua MCP ([ADR 0012](../adr/0012-mcp-endpoint.md)) đọc được tin nhắn, hồ sơ người dùng và bot trong các cuộc trò chuyện của chính người dùng đó trong phạm vi quyền đã duyệt ở IdP, rồi gửi chúng tới nhà cung cấp AI người dùng chọn (có thể ở nước ngoài). Đây là chuyển dữ liệu do chính người dùng khởi tạo và duyệt trên trang cấp quyền; app chat không chọn nhà cung cấp và không lưu gì thêm. Người dùng thu hồi ở `auth.<domain>/account` (token đang có còn hiệu lực tối đa 15 phút).
