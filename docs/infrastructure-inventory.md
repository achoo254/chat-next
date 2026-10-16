# Hạ tầng chat đã triển khai

Danh mục những gì app chat đã tạo hoặc thay đổi bên ngoài repo, đối chiếu với hiện trạng trên server `103.72.98.65` ngày 2026-10-15. Cách deploy, rollback và vận hành hằng ngày nằm ở [deployment-guide.md](deployment-guide.md); file này chỉ trả lời câu "trên máy và trên các dịch vụ ngoài đang có gì của chat". Khi thêm hoặc bỏ một thành phần hạ tầng, cập nhật file này cùng commit.

Quyết định hiện hành (2026-10-15): server `.65` là nơi lưu trung tâm cho mọi thứ (DB, media, backup) cho tới khi có người dùng thật; chưa có lưu trữ hay backup ra ngoài server.

## Server `.65` (CentOS Stream 9, dùng chung với IdP và các app khác)

### Gói hệ thống

| Gói | Bản | Ghi chú |
|---|---|---|
| `postgresql-server` | 16.8 (module AppStream `postgresql:16`) | Có sẵn trước khi có chat, dùng chung |
| `postgresql-contrib` | 16.8 | **Chat cài ngày 2026-10-15** để có `pg_trgm` cho tìm kiếm chuỗi con; kéo theo `uuid` 1.6.2. Không khởi động lại Postgres |
| `nginx` | 1.20.1 | Có sẵn, dùng chung; không hỗ trợ directive `http2` riêng |
| `certbot`, `python3-certbot-dns-cloudflare` | 3.1.0 | Có sẵn, dùng chung |
| `ffmpeg` | chưa cài | Tuỳ chọn cho poster video và sóng âm phía server (`MEDIA_FFMPEG_PATH`) |

### User hệ thống

| User | Home / shell | Dùng cho |
|---|---|---|
| `chat` | `/opt/chat`, `nologin` | Chạy tiến trình `chat-api` (uid trong `ecosystem.config.cjs`), sở hữu `/opt/chat/media` |
| `chat-deploy` | `/home/chat-deploy`, `bash` | GitHub Actions upload release; `authorized_keys` có `restrict`; chỉ được sudo một lệnh |

### Thư mục

| Đường dẫn | Chủ / quyền | Nội dung |
|---|---|---|
| `/opt/chat` | root:root 755 | Gốc của app |
| `/opt/chat/.env` | root:chat 640 | Cấu hình prod (danh sách biến bên dưới) |
| `/opt/chat/releases/<id>` | root:root 755 | Release đã build (giữ 5 bản), `current` là symlink |
| `/opt/chat/infra` | root:root 755 | Bản sao `infra/chat/` (script, conf nginx) |
| `/opt/chat/backups` | root:chat 750 | Dump DB (`backup-chat-db.sh`, giữ 14 bản) |
| `/opt/chat/media` | chat:chat 750 | File media (driver filesystem); không cho nginx đọc trực tiếp |
| `/opt/chat/media/exports` | chat:chat 750 | Bản xuất dữ liệu cá nhân (ZIP, giữ 30 ngày); app tự tạo khi chạy bản có migration 0019, không do script hay tay tạo |
| `/opt/chat/tenants` | root:chat 750 | Một file `<id>.env` (root:chat 640) cho mỗi tenant ngoài tenant chính (`setup-tenant.sh`). Ngày 2026-10-16 tạo `inetdev.env` (tenant nghiệm thu `inetdev.io.vn`, cổng `4601`, cùng DB); `OIDC_CLIENT_SECRET` còn trống, nên `chat-api-inetdev` chưa chạy |
| `/opt/chat/incoming` | chat-deploy 750 | Nơi CI upload release |
| `/opt/chat/staging` | root 700 | Bản upload được đổi chủ sang root rồi mới kiểm |
| `/var/log/chat` | root:root 755 | Log pm2 của `chat-api` và log backup (thuộc root để app không thay log bằng symlink) |

### Biến trong `/opt/chat/.env` (chỉ tên)

`CHAT_ENV`, `CHAT_LISTEN_ADDR`, `CHAT_PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TENANT_ID`, `TENANT_DOMAIN`, `SESSION_KEY`, `DATABASE_URL`, `MEDIA_PUBLIC_URL`, `MEDIA_STORAGE`, `MEDIA_ROOT`, `MEDIA_MIN_FREE_BYTES`, `MEDIA_UPLOAD_MAX_BYTES`, `MEDIA_USER_QUOTA_BYTES`, `WEB_PUSH_VAPID_PRIVATE_KEY` (sinh trên server ngày 2026-10-16 bằng `infra/chat/generate-vapid-key.sh`, không bao giờ thay: thay khoá làm mất mọi đăng ký push), `OUTBOUND_DENY_CIDRS` (`103.72.98.65`, đặt ngày 2026-10-15: webhook bot và xem trước link không gọi về chính máy). Mẫu và ý nghĩa: [`infra/chat/.env.production.example`](../infra/chat/.env.production.example). `CHAT_OPERATOR_USER_IDS` (`1` = `@achoo254`, chủ sản phẩm, đặt ngày 2026-10-15 theo quyết định của user: xem hàng đợi kiểm duyệt và góp ý). Chưa đặt: `MEDIA_FFMPEG_PATH`, `WEB_PUSH_SUBJECT` (tuỳ chọn). File `.env.bak-*` là bản sao trước mỗi lần sửa tay.

### Tiến trình (pm2 dùng chung, daemon chạy bằng root)

| App | Lệnh | Ghi chú |
|---|---|---|
| `chat-api` | `/opt/chat/current/server -role api -env-file /opt/chat/.env` | Một instance, uid `chat`, nghe `127.0.0.1:4600`; gồm cả gateway WebSocket, webhook, Bot API (`/bot/v1/`, consumer outbox `bots`), media, worker media và dọn rác; `kill_timeout` 70 s, restart khi vượt 700 MB, `GOMEMLIMIT=450MiB` |

`chat-api-<id>`: một process cho mỗi `/opt/chat/tenants/<id>.env` đã có secret OIDC (`ecosystem.config.cjs`), cùng release, nghe cổng ghi trong file đó, log `/var/log/chat/api-<id>.*.log`.

### nginx (`/etc/nginx/conf.d/`)

| File | Vai trò |
|---|---|
| `chat-http.conf` | Cấp `http`: log format không ghi query, zone rate limit `chat_auth`, `chat_rpc` (cài một lần bằng `setup-server.sh`) |
| `chat.hoandat.com.conf` | Web tĩnh, `/rpc/`, `/auth/`, `/ws`, `/hook/` (log che secret), `/bot/` (Bot API, R5: không cookie, body 1 MiB, đọc 65 s cho long poll, zone `chat_bot` 600 r/s mỗi IP burst 1200 trên tầng cao nhất của bot, vượt thì `429` JSON; method do app kiểm, `405` JSON), `/bot/v1/messages:send…` (R5 lát B2: gửi file của bot `messages:sendMedia`/`messages:sendAlbum`, như `/bot/` nhưng body tới 51 MiB, nhận body 120 s; app giới hạn 50 MiB), `/healthz`, `/sw.js` (từ bản hardening webhook: `/opt/chat/sw-override/sw.js` nếu có, không thì của release, thiếu thì `404`; xem kill switch trong deployment guide); zone `chat_ws`, `chat_hook`, `chat_bot` khai báo trong file này |
| `media-chat.hoandat.com.conf` | Host media, proxy tới app (app stream file, Range) |
| `chat.tenants.conf` | Chỉ có khi có tenant khác tenant chính: map `chat.<domain>` → cổng của process và block regex `chat.<tenant>` dựng từ `chat.hoandat.com.conf` (`render-tenants-nginx.sh`), chứng chỉ qua map `$tenant_cert` của `hoandat-auth` (`00-tenants-http.conf`) |
| `*.prev` | Bản trước, do `activate-release.sh` giữ để tự trả lại khi `nginx -t` lỗi |

Thông tin IP thật của client lấy từ cấu hình real-IP Cloudflare có sẵn ở cấp `http` (file của app khác).

### PostgreSQL (dùng chung, cổng 5432, chỉ localhost)

- Database `chat`, role `chat` (scram-sha-256), hai dòng `pg_hba.conf` 117–118 đặt trước các dòng `ident` chung; bản sao trước khi sửa là `pg_hba.conf.bak-20261014-090118` cạnh file.
- Migration goose 0001–0012 (bảng `goose_db_version`). Extension `pg_trgm` (gói `postgresql-contrib`) do migration 0012 tạo trong DB `chat`, chủ là role `chat` (chủ database, không phải superuser). Index trigram `gin_trgm_ops` trên `messages.search_text`.
- Không sửa `postgresql.conf` hay cấu hình chung nào.

### Cron, sudo, chứng chỉ

- `/etc/cron.d/chat-backup`: 02:50 hằng ngày chạy `backup-chat-db.sh`.
- `/etc/sudoers.d/chat-deploy`: `chat-deploy` chỉ được chạy `/usr/local/sbin/chat-activate-incoming` (bản cài của `activate-incoming.sh`), `secure_path` riêng có `/usr/local/bin` để thấy `pm2`.
- Let's Encrypt (DNS-01 Cloudflare, gia hạn bằng timer certbot có sẵn, `--deploy-hook "systemctl reload nginx"`):
  - `chat.hoandat.com` + `*.chat.hoandat.com`, hết hạn 2027-01-12.
  - `media-chat.hoandat.com`, hết hạn 2027-01-12.
- Token Cloudflare Zone:DNS:Edit dùng lại file có sẵn `/etc/letsencrypt/cloudflare-localman.ini` (chỉ dùng được từ IP `.65`), không tạo token mới.

### Tường lửa

Chat không đổi tường lửa. Cổng 443 đang mở cho mọi IP (cấu hình chung). Vì server tự lấy trang để làm xem trước link, chủ trang đó thấy IP gốc của `.65`; giới hạn 443 cho dải Cloudflare là việc của cả máy, chưa làm.

## Ngoài server

| Dịch vụ | Đã tạo | Ghi chú |
|---|---|---|
| Cloudflare, zone `hoandat.com` | `chat.hoandat.com` (A, proxied), `media-chat.hoandat.com` (A, proxied, tạo bằng `infra/chat/ensure-dns.sh`) | Không dùng host hai cấp như `hook.chat.…` vì SSL miễn phí chỉ phủ một cấp; webhook nằm ở `chat.<d>/hook/…` |
| Cloudflare, zone `inetdev.io.vn` | `chat.inetdev.io.vn` (A → `103.72.98.65`, proxied; user tạo ngày 2026-10-16). Zone ở SSL Flexible; Configuration Rule (phase `http_config_settings`, rule `fa7a7e76b552427ab6eca834b1c66c46`) đặt Full (strict) riêng cho `chat.inetdev.io.vn`, vì Flexible cắt WebSocket | Tenant nghiệm thu; phía IdP (chứng chỉ có `chat.`, hỗ trợ host proxied) và rule do phiên `hoandat-auth` làm theo quyết định của user. Gỡ: xoá rule đó |
| IdP `hoandat-auth` (cùng server) | Client OIDC `chat-web`, `chat-mobile`, `chat-desktop`; biến `CHAT_WEB_URL`, `CHAT_WEB_CLIENT_SECRET` trong `/var/www/hoandat-auth/.env` (`CHAT_MOBILE_REDIRECT_URI` để mặc định trong code) | Secret sinh trên server, cùng giá trị với `OIDC_CLIENT_SECRET` của chat |
| GitHub `achoo254/chat-next` | Workflow `ci`, `deploy`; secret `CHAT_DEPLOY_SSH_KEY`, `CHAT_DEPLOY_KNOWN_HOSTS`; environment `production` | Key ed25519 của `chat-deploy` chỉ nằm trong secret |
| Dịch vụ push của trình duyệt (Google FCM, Mozilla, Microsoft WNS, Apple) | Không tạo gì: không tài khoản, không project; xác thực bằng khoá VAPID của chính server | `chat-api` gọi ra https tới `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com` (chỉ các host này, allowlist trong code) khi Web Push bật; nội dung đã mã hoá theo từng trình duyệt |
| OneDash (hệ nb), dịch vụ `dattqh-test` | Bucket `chat-media`, danh tính `chat-api` (quyền `write`) | **Không dùng** (media chuyển về đĩa `.65`); có thể xoá trên web OneDash |

## Đổi gì thì cập nhật gì

- Thêm gói, user, thư mục, conf nginx, cron, DNS, chứng chỉ hoặc secret: thêm dòng vào file này trong cùng commit với script hoặc thao tác đó.
- Đổi cách deploy hoặc rollback: [deployment-guide.md](deployment-guide.md).
- Khi chuyển lên cụm riêng (Phase 13 giai đoạn 2): ghi lại phần nào rời `.65` và gỡ phần cũ ở đây.
