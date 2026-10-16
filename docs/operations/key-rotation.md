# Xoay vòng khoá

Runbook đổi khoá và secret của app chat trên production. Mọi lệnh chạy trên server `.65` bằng root (vào máy theo skill `chat-ops-prod`), không in giá trị khoá ra màn hình hay log. Mỗi lần đổi ghi một dòng vào [`docs/infrastructure-inventory.md`](../infrastructure-inventory.md) (ngày, tenant, lý do), không ghi giá trị.

## Danh mục

| Khoá, secret | Nằm ở | Bảo vệ gì | Cách đổi |
|---|---|---|---|
| `SESSION_KEY` | `/opt/chat/.env`, mỗi tenant một khoá riêng ở `/opt/chat/tenants/<id>.env` | Refresh token và ID token của IdP trong `user_sessions`, secret webhook của bot trong `bots`, cookie đăng nhập, URL tải media và URL tải bản xuất dữ liệu | [Mục dưới](#session_key), không ai bị đăng xuất |
| `OIDC_CLIENT_SECRET` | Như trên | Client `chat-web` khi gọi IdP | [Mục dưới](#oidc_client_secret) |
| Mật khẩu role Postgres `chat` | `DATABASE_URL` trong mọi env file của chat | Database `chat` | [Mục dưới](#mật-khẩu-database) |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | `/opt/chat/.env` | Đăng ký Web Push | **Không đổi**: đổi làm mất mọi đăng ký push. Chỉ đổi khi khoá lộ, chấp nhận người dùng phải bật lại thông báo |
| Token bot | Băm SHA-256 trong `bots` | Bot API | Chủ bot bấm "Cấp lại token" trong Developer Console (cần đăng nhập lại trong 10 phút) |
| Secret của incoming hook | Băm trong `incoming_hooks` | `POST /hook/<id>/<secret>` | Người quản lý chat đổi secret trong phần hook; secret cũ còn chạy 7 ngày trừ khi thu hồi |
| Token Cloudflare sửa DNS | `/etc/letsencrypt/cloudflare-localman.ini` (dùng chung với Localman) | Zone `hoandat.com` | Ngoài phạm vi chat: đổi trên Cloudflare rồi ghi file, báo các app cùng dùng |

Khoá APNs, FCM và khoá ký OTA chưa có (R7/R8); thêm vào bảng khi tạo.

## `SESSION_KEY`

Mỗi giá trị lưu bằng `SESSION_KEY` mang key id của khoá đã niêm phong nó (`server/internal/sealbox`). Khi `.env` có `SESSION_KEY_PREVIOUS`, server niêm phong và ký bằng `SESSION_KEY`, còn mở và kiểm bằng cả hai khoá. Role `reseal` của binary niêm phong lại mọi giá trị đang lưu của tenant bằng khoá hiện tại; giá trị nào hai khoá đều không mở được được đếm là `unreadable` và để nguyên. Ngoài ra kiểm tra grant mỗi phiên và lần giao webhook cũng tự chuyển giá trị chúng dùng sang khoá mới.

Script [`infra/chat/rotate-session-key.sh`](../../infra/chat/rotate-session-key.sh) làm cả quy trình. Tham số thứ hai là id tenant; bỏ trống là tenant chính.

1. Bắt đầu: `bash /opt/chat/infra/rotate-session-key.sh start` (tenant khác: `… start inetdev`). Script backup database (`backup-chat-db.sh`) và env file (`<env>.rotate-bak-<thời gian>`), chuyển khoá cũ sang `SESSION_KEY_PREVIOUS`, sinh `SESSION_KEY` mới, ghi thời điểm bắt đầu (`<env>.rotation-started`), reload đúng process của tenant (`chat-api` hoặc `chat-api-<id>`) rồi chạy `reseal`. Kết quả đúng: hai dòng log `resealed session IdP tokens` và `resealed bot webhook secrets` với `unreadable: 0`, `key_id` mới khác `previous_key_id`. Nếu reload hoặc `reseal` lỗi, khoá mới đã nằm trong file: sửa nguyên nhân rồi chạy `rotate-session-key.sh reseal` (cùng tenant), không chạy lại `start` và chưa chạy `finish`.
2. Chờ ít nhất 6 giờ: URL tải lên phần media sống 6 giờ, URL tải media 1 giờ, URL tải bản xuất 10 phút, cookie đăng nhập 10 phút. Các token này không lưu nên `reseal` không chuyển được, chúng còn hợp lệ nhờ khoá cũ.
3. Kết thúc: `bash /opt/chat/infra/rotate-session-key.sh finish` (cùng tenant). Script từ chối nếu chưa đủ 6 giờ từ `start`. Nó chạy `reseal` khi khoá cũ còn trong file và dừng nếu có giá trị không đọc được; sạch thì xoá `SESSION_KEY_PREVIOUS`, reload, chạy `reseal` lần nữa (mọi giá trị phải là `current`) rồi xoá các bản `rotate-bak` của lần xoay này, vì đó là bản cuối còn giữ khoá cũ.

Kiểm tra sau mỗi bước: `bash infra/chat/smoke.sh https://chat.<domain>` và đăng nhập thử một lần.

### Khi khoá bị lộ

Làm bước 1, rồi làm ngay bước 3 với `--now` (`rotate-session-key.sh finish --now`). URL media và URL tải bản xuất đã phát hành không còn dùng được (app tải lại URL mới), ai đang ở giữa lần đăng nhập phải đăng nhập lại. Không ai bị đăng xuất. Sau đó đổi luôn `OIDC_CLIENT_SECRET` và mật khẩu database nếu `.env` cũng lộ.

Khoá cũ còn ở hai nơi script không dọn: các bản `.env.bak-*` do người sửa tay `.env` để lại (xoá những bản có khoá đã lộ), và các bản dump database của `backup-chat-db.sh` (giữ 14 bản), trong đó token đã niêm phong bằng khoá cũ. Ai có cả dump lẫn khoá cũ mở được refresh token trong dump; các token đó vẫn bị IdP thu hồi khi phiên kết thúc, nên khi khoá lộ cùng dump thì đăng xuất mọi phiên của tenant (thu hồi grant ở IdP) thay vì chỉ xoay khoá.

### Khi `reseal` báo `unreadable` khác 0

Role trả mã thoát 1 và script dừng; ở bước 3 script dừng trước khi bỏ khoá cũ. Giữ nguyên `SESSION_KEY_PREVIOUS`. Nguyên nhân thường gặp: dữ liệu niêm phong bằng một khoá cũ hơn khoá trước đó (đã xoay hai lần mà lần trước chưa `finish`), hoặc env file khôi phục nhầm bản backup. Tìm bản `.env.bak-*` có khoá đúng và chạy `reseal` với khoá đó làm `SESSION_KEY_PREVIOUS`. Không tìm được thì chấp nhận: phiên có token không mở được bị kết thúc ở lần kiểm tra grant tới (người dùng đăng nhập lại), webhook của bot báo `secret_unreadable` cho tới khi chủ bot lưu lại webhook.

### Rollback

Phục hồi env file từ `<env>.rotate-bak-<thời gian>` của bước vừa làm và reload process (`pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`). Giá trị đã niêm phong bằng khoá mới chỉ mở được khi khoá mới còn trong file (làm `SESSION_KEY` hoặc `SESSION_KEY_PREVIOUS`), nên rollback sau bước 1 thì đặt khoá mới làm `SESSION_KEY_PREVIOUS` thay vì bỏ hẳn, rồi chạy `rotate-session-key.sh reseal`. Release cũ hơn bản có `SESSION_KEY_PREVIOUS` (trước 2026-10-16) không đọc được giá trị có key id: không rollback code về đó sau khi đã xoay khoá.

## `OIDC_CLIENT_SECRET`

Secret của `chat-web` do IdP sinh (`APP_CLIENT_SECRET_KEY` của `hoandat-auth`, dẫn xuất theo domain). Việc đổi làm ở phiên của repo `hoandat-auth` theo `hoandat-auth/docs/deployment-guide.md`; phía chat chỉ ghi giá trị mới vào `OIDC_CLIENT_SECRET` của env file tương ứng (backup trước) và reload process. Giữa lúc IdP đổi và lúc chat reload, đăng nhập và kiểm tra grant lỗi `invalid_client` (phiên vẫn còn, kiểm tra được thử lại sau), nên làm hai việc liền nhau.

## Mật khẩu database

1. Backup env file của mọi tenant.
2. Sinh mật khẩu mới và đổi trong Postgres: `ALTER ROLE chat PASSWORD '<mới>'` qua `infra/chat/psql.sh` (đọc mật khẩu từ biến, không gõ vào lệnh lưu lịch sử).
3. Thay mật khẩu trong `DATABASE_URL` của `/opt/chat/.env` và mọi `/opt/chat/tenants/*.env` (các tenant dùng chung database), reload `chat-api` và mọi `chat-api-<id>`. Kết nối đang mở vẫn chạy tới khi pool đóng chúng.
4. Kiểm tra: smoke cho mọi tenant, `pm2 logs chat-api --lines 50 --nostream` không có lỗi xác thực Postgres.
