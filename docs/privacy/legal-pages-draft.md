# Trang chính sách công khai

> **Đã duyệt để phát hành: Jev (được chủ sở hữu uỷ quyền), 20/10/2026**, theo hướng "điền chỗ trống rồi phát hành". Nội dung `/privacy`, `/terms`, `/delete-account` viết lại từ sự thật trong repo và các thông tin vận hành ghi ở mục "Thông tin vận hành" bên dưới; chưa phải ý kiến pháp lý. Những gì chưa có căn cứ hiện trên trang dưới mục "Đang cập nhật" (xem "Còn thiếu").

Ba trang mở được khi chưa đăng nhập (router `matchLegal` trong [`apps/web/src/router.tsx`](../../apps/web/src/router.tsx), hiển thị trước bước kiểm phiên ở [`apps/web/src/app.tsx`](../../apps/web/src/app.tsx)). nginx không cần sửa: `location /` của [`infra/chat/nginx/chat.hoandat.com.conf`](../../infra/chat/nginx/chat.hoandat.com.conf) đã `try_files $uri /index.html`, và service worker coi mọi lần mở trang cùng origin là trang của app ([`shell-routes.ts`](../../apps/web/src/sw/shell-routes.ts)). Có link ở màn hình đăng nhập và ở Cài đặt (mở tab mới). `/delete-account` dùng được làm URL xoá tài khoản khai cho kho ứng dụng.

Văn bản: [`apps/web/src/screens/legal/legal-copy.ts`](../../apps/web/src/screens/legal/legal-copy.ts) (vi, en). Các dòng "Điều gì xảy ra" khi xoá tài khoản dùng chung với Cài đặt › Tài khoản: [`apps/web/src/i18n/account-deletion.ts`](../../apps/web/src/i18n/account-deletion.ts). Tên app, domain, host IdP lấy từ `brand.config.json`. Câu về dịch vụ push dùng chung với tab Cài đặt › Quyền riêng tư: [`apps/web/src/i18n/push-services.ts`](../../apps/web/src/i18n/push-services.ts). Sửa một sự thật thì sửa cả bảng dưới, file nguồn và `legal-copy.ts`.

## Thông tin vận hành

Email liên hệ, vị trí máy chủ và Cloudflare là sự thật của dịch vụ `hoandat.com` do nhà vận hành chạy. Từ 24/10/2026 hệ sinh thái chỉ còn domain này (ADR 0013 Đơn tenant của `auth-next`), nên trang luôn hiện chúng (`OPERATOR_EMAIL` trong `legal-copy.ts`).

| Khẳng định | Nguồn |
|---|---|
| Liên hệ về quyền riêng tư, điều khoản và yêu cầu xoá: `quocdat254@gmail.com` | Quyết định của Jev, 20/10/2026; cùng địa chỉ đã công bố làm liên hệ trên trang quyền riêng tư công khai của Miu (`content/legal/privacy-vi.json` trong repo `miu-world-next`) |
| Không đăng nhập được thì gửi yêu cầu xoá tới email đó, kèm username và email tài khoản `<domain>` (đường không cần đăng nhập, dùng cho URL xoá của kho ứng dụng) | Quyết định của Jev, 20/10/2026; người vận hành xử lý tay |
| Máy chủ đặt tại Việt Nam | whois IP `<SERVER_65_IP>` (máy chủ trong [infrastructure-inventory.md](../infrastructure-inventory.md)): country VN, mạng của iNET; đo ngày 20/10/2026 |
| Kết nối tới `chat.hoandat.com` đi qua Cloudflare | infrastructure-inventory.md "Ngoài server": bản ghi A proxied của zone `hoandat.com` |

## Chính sách quyền riêng tư (`/privacy`)

| Khẳng định | Nguồn |
|---|---|
| Đăng nhập bằng tài khoản `<domain>` ở `auth.<domain>`, Google hoặc GitHub; app không thấy mật khẩu | [ADR 0006](../adr/0006-sign-in-and-chat-sessions.md); `welcome.hint` trong [`apps/web/src/i18n/vi.ts`](../../apps/web/src/i18n/vi.ts) |
| Danh tính Google/GitHub, email gốc, cách đăng nhập do IdP giữ; quản lý/xoá ở `auth.<domain>/account` | [data-inventory.md](data-inventory.md) mục "IdP và app chat" |
| Hồ sơ: username, tên, giới thiệu, mã tài khoản IdP | data-inventory.md, dòng `users` |
| Email: bản sao đã xác minh, đọc lại mỗi lần đăng nhập; tìm theo email mặc định Không ai | data-inventory.md, dòng `users.email`; `privacy.findByEmailHint` trong [`vi-screens.ts`](../../apps/web/src/messaging/copy/vi-screens.ts) |
| Phiên: IP, user agent, thời điểm; trượt 30 ngày, trần 90 ngày (web) | data-inventory.md, dòng `user_sessions` |
| Tin, cảm xúc, ghim, trạng thái đọc, file media | data-inventory.md |
| Danh bạ, chặn, cài đặt quyền riêng tư/thông báo/tự xoá | data-inventory.md |
| Đăng ký Web Push khi người dùng bật | data-inventory.md, dòng `push_subscriptions` |
| Góp ý đã che email và số điện thoại | data-inventory.md, dòng `feedback` |
| Báo cáo đã gửi; giữ sau khi xoá tài khoản | data-inventory.md, dòng `reports`, `moderation_log` |
| Lỗi trình duyệt đã che email, không gắn user, 90 ngày | data-inventory.md, dòng `client_errors` |
| Mục đích: dịch vụ đã đăng ký (HĐ), tự bật (ĐY), an toàn và chống lạm dụng (NV) | data-inventory.md, cột "Cơ sở" |
| DB, file, sao lưu trên máy chủ của nhà vận hành; chưa lưu hay sao lưu ra ngoài máy chủ | [infrastructure-inventory.md](../infrastructure-inventory.md), "Quyết định hiện hành (2026-10-15)" |
| Log chỉ ghi id, không nội dung tin, email, token | data-inventory.md, dòng "Log ứng dụng, nginx"; `server/internal/logging/redact` |
| File giữ tới khi không còn tin dùng, thêm 1 ngày | data-inventory.md, dòng "File media" |
| Chi tiết đã đọc 7 ngày; log đồng bộ 30 ngày | data-inventory.md, dòng tin nhắn (`read_receipts`) và "Log cập nhật đồng bộ" |
| Inline query 1 ngày; gửi hàng loạt 30 ngày sau khi xong | data-inventory.md, dòng `bot_inline_queries`, `bot_bulk_jobs` |
| Bản xuất giữ 30 ngày; mỗi 7 ngày một lần; nội dung bản xuất | data-inventory.md "Quyền của người dùng"; `ExportRetention`, `ExportInterval` trong [`server/internal/privacy/privacy.go`](../../server/internal/privacy/privacy.go) |
| Sao lưu 14 bản hằng ngày, dữ liệu đã xoá còn tối đa 14 ngày | data-inventory.md, dòng "Bản sao lưu DB"; [`infra/chat/backup-chat-db.sh`](../../infra/chat/backup-chat-db.sh) |
| Push qua dịch vụ của trình duyệt (Apple, Google, Mozilla, Microsoft), ở nước ngoài; mã hoá theo trình duyệt; dịch vụ push chỉ thấy endpoint, kích thước, thời điểm. Cùng câu ở tab Cài đặt › Quyền riêng tư (trước đây tab chỉ nêu Apple và Google) | data-inventory.md "Chuyển dữ liệu ra nước ngoài"; infrastructure-inventory.md "Ngoài server"; `push-services.ts` |
| Tắt xem trước trong thông báo ở Cài đặt › Thông báo | `privacy.previewHint` trong vi-screens.ts; tab Thông báo ở [`settings-extra.tsx`](../../apps/web/src/messaging/settings/settings-extra.tsx) |
| Bot chạy trên máy chủ của người tạo; tin, lệnh, nút, inline query gửi tới máy chủ đó | [docs/bot-api/README.md](../bot-api/README.md) (long poll, webhook); [`spec/bot-api/openapi.yaml`](../../spec/bot-api/openapi.yaml) |
| Cài đặt quyền riêng tư áp dụng cả cho bot | `privacy.lede` trong vi-screens.ts |
| Bot chỉ gửi hàng loạt cho người đã bắt đầu bot | data-inventory.md, dòng `bot_bulk_jobs` |
| Mini App là trang của người tạo bot, app hiện tên miền | [`apps/web/src/messaging/bots/mini-app.tsx`](../../apps/web/src/messaging/bots/mini-app.tsx) (`ma-origin`); CSP `frame-src https:` trong conf nginx |
| Bản sao chat trong trình duyệt không mã hoá, tách theo tài khoản, xoá khi đăng xuất | [ADR 0009](../adr/0009-local-storage.md) |
| Cài đặt quyền riêng tư (ai thấy, ai tìm, ai thêm vào nhóm, ai nhắn) | `PrivacySettings` trong settings-extra.tsx |
| Xem và đăng xuất phiên | [`sessions-settings.tsx`](../../apps/web/src/screens/settings/sessions-settings.tsx) |
| Tự xoá 6/12/24 tháng, mặc định tắt | `AutoDeleteMonths` trong privacy.go; data-inventory.md |
| Liên hệ: email ở mục "Thông tin vận hành"; trong app qua Cài đặt › Góp ý, trả lời qua bot Trợ lý | `feedback.hint` trong vi-screens.ts |
| "Đang cập nhật": tên pháp nhân vận hành | Chưa có trong repo (xem "Còn thiếu") |

## Điều khoản sử dụng (`/terms`)

| Khẳng định | Nguồn |
|---|---|
| Dùng bằng tài khoản `<domain>`; xoá tài khoản chat không xoá tài khoản `<domain>` | data-inventory.md "IdP và app chat" |
| Báo cáo tin/người/chat vì spam, lừa đảo, bạo lực, khiêu dâm, khác; người kiểm duyệt xem xét | `report` trong vi-screens.ts (`doneBody`) |
| Biện pháp: gỡ nội dung, xoá và cấm khỏi chat, cảnh cáo, khoá tài khoản chat, giới hạn chat với người chưa quen, bot về tầng Hạn chế, tắt webhook | `moderation.actionNames` trong vi-screens.ts |
| Tài khoản mới nhắn người lạ bị giới hạn số tin | `privacy.sendMessagesHint` trong vi-screens.ts; `stranger_chat_limit` trong [`private-chat-failure.ts`](../../apps/web/src/messaging/ui/private-chat-failure.ts) |
| Bot vi phạm luật chống lạm dụng tự về tầng Hạn chế | `restrictedAuto` trong vi-screens.ts |
| Chủ nhóm/kênh phải chuyển quyền hoặc xoá trước khi xoá tài khoản | data-inventory.md "Quyền của người dùng"; `account.ownsChats` |
| Tạo bot ở Developer Console; token hiện một lần, server giữ hash | docs/bot-api/README.md mục 1 |
| Bot dừng khi bắt đầu xoá tài khoản, xoá cùng tài khoản | data-inventory.md, dòng `bots` |
| Liên hệ về điều khoản: email ở mục "Thông tin vận hành" | Quyết định của Jev |
| "Đang cập nhật": pháp nhân, độ tuổi tối thiểu, giới hạn trách nhiệm, luật áp dụng, giải quyết tranh chấp | Chưa có trong repo (xem "Còn thiếu") |

## Xoá tài khoản (`/delete-account`)

| Khẳng định | Nguồn |
|---|---|
| Các bước: đăng nhập, Cài đặt › Tài khoản, đăng nhập lại trong 10 phút nếu được hỏi, gõ username | [`account-settings.tsx`](../../apps/web/src/messaging/settings/account-settings.tsx); `RecentSignIn` trong privacy.go |
| Bốn dòng "Điều gì xảy ra" | `account-deletion.ts` (cùng nguồn với Cài đặt › Tài khoản) |
| Khoá ngay, xoá hẳn sau 30 ngày; đăng nhập lại để huỷ | `GracePeriod` trong privacy.go; data-inventory.md |
| Mọi thiết bị đăng xuất; bot dừng ngay | data-inventory.md "Xoá tài khoản chat"; `account.confirmBody` |
| Sao lưu còn tối đa 14 ngày; báo cáo và nhật ký kiểm duyệt được giữ | data-inventory.md |
| Xoá tài khoản `<domain>` ở trang tài khoản IdP | data-inventory.md; `brand.accountUrl` trong `brand.ts` |
| "Không đăng nhập được?": gửi yêu cầu tới email liên hệ | Mục "Thông tin vận hành" |

## Còn thiếu

Trang hiện các mục này dưới tiêu đề "Đang cập nhật" thay vì viết nội dung không có căn cứ:

- Tên pháp nhân vận hành dịch vụ (và địa chỉ).
- Độ tuổi tối thiểu, giới hạn trách nhiệm, luật áp dụng, giải quyết tranh chấp, cách báo trước khi đổi điều khoản.

Chưa đưa lên trang:

- Nghị định 13/2023/NĐ-CP: repo chỉ nhắc trong tài liệu nội bộ (data-inventory.md, "chưa phải ý kiến pháp lý") và comment của `server/internal/privacy`, không có trong giao diện; trang công khai không trích. Đánh giá tác động chuyển dữ liệu ra nước ngoài (Điều 25) vẫn còn phải làm.
- App mobile: ADR 0009 quyết định SQLCipher cho bản sao trên điện thoại; trang chỉ nói về trình duyệt, thêm khi app mobile phát hành.
