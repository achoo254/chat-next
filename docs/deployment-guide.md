# Deploy chat (chat.hoandat.com)

Giai đoạn 1 của hạ tầng: app chat chạy chung server `103.72.98.65` với IdP, Localman và các app khác, theo quy ước của server đó (pm2, nginx một file mỗi host, không Docker Compose). Vận hành hằng ngày qua skill [`chat-ops-prod`](../.claude/skills/chat-ops-prod/SKILL.md). Khi tải chạm ngưỡng thì chuyển lên cụm riêng (plan, Phase 13 giai đoạn 2).

## Thành phần

| Thành phần | Vị trí |
|---|---|
| DNS (Cloudflare, zone `hoandat.com`) | `chat` → `103.72.98.65`, proxied. Webhook không cần bản ghi riêng: nằm ở `https://chat.hoandat.com/hook/…`, vì Universal SSL miễn phí của Cloudflare chỉ phủ `*.hoandat.com`, không phủ host cấp hai như `hook.chat.hoandat.com` (quyết định 2026-10-15). `*.chat` (bot) thêm khi có release cần. `media-chat` → `103.72.98.65`, proxied: host media tạm thời (R3), host cấp một nên Universal SSL phủ được; trước R9 chuyển sang domain đăng ký riêng (ADR 0010) |
| TLS | Let's Encrypt `chat.hoandat.com` + `*.chat.hoandat.com`, DNS-01 Cloudflare với token Zone:DNS:Edit đã có trên server (`/etc/letsencrypt/cloudflare-localman.ini`), gia hạn bằng timer certbot kèm `systemctl reload nginx` ([`issue-cert.sh`](../infra/chat/issue-cert.sh)). Chứng chỉ trên không phủ `media-chat.hoandat.com`: host này có chứng chỉ Let's Encrypt riêng ở `/etc/letsencrypt/live/media-chat.hoandat.com/` (đã cấp 2026-10-15) |
| Release | `/opt/chat/releases/<id>/{server,web,nginx}`, id = giờ UTC + commit 12 ký tự (+`-dirty`), symlink `/opt/chat/current`; giữ 5 bản |
| Process | pm2 `chat-api` ([`ecosystem.config.cjs`](../infra/chat/ecosystem.config.cjs)), một instance, user hệ thống `chat`, binary Go tĩnh `server -role api -env-file /opt/chat/.env`, nghe `127.0.0.1:4600`, restart khi vượt 700 MB (`GOMEMLIMIT=450MiB`; ảnh được giải mã trong process với ngân sách 256 MiB, xem [Media](#media-r3)). Gateway realtime (WebSocket `/ws`) chạy trong chính process này, không có process hay cổng riêng |
| nginx | `/etc/nginx/conf.d/chat-http.conf` (log format bỏ query, zone rate limit; cài một lần) và `/etc/nginx/conf.d/chat.hoandat.com.conf` (mỗi release mang bản của nó, [`nginx/`](../infra/chat/nginx/)). Web tĩnh từ `current/web`, `/rpc/` và `/auth/` tới API, `/ws` tới API với header `Upgrade`/`Connection` (timeout đọc 75 s, rate limit handshake theo zone riêng `chat_ws` 10 r/s, burst 200, khai báo ngay trong conf của site nên không phải cài lại `chat-http.conf`; đừng khai báo `chat_ws` lần nữa ở `chat-http.conf`), `/healthz` công khai. `/hook/` (webhook) chỉ nhận `POST`, tới API không kèm cookie, zone rate limit riêng `chat_hook` 50 r/s mỗi IP (burst 200, khai báo trong conf của site như `chat_ws`), body tối đa 128 KiB ở nginx (app giới hạn 64 KiB và tự trả 413 để còn đếm), access log ghi `/hook/<id>/[redacted]` thay cho đường dẫn chứa secret (log format `chat_hook`), error log của nginx tắt cho location này vì nginx chép dòng request vào đó. CSP `connect-src` có `wss://chat.hoandat.com`; `script-src` có `'wasm-unsafe-eval'` và có `worker-src 'self'` (SQLite wasm với OPFS chạy trong worker cùng origin) |
| nginx media | `/etc/nginx/conf.d/media-chat.hoandat.com.conf` ([bản trong repo](../infra/chat/nginx/media-chat.hoandat.com.conf)), chỉ được cài khi chứng chỉ của host đã có. Chỉ mở `GET/HEAD /f/<token>` (tải, Range, không buffer, zone `chat_media` 100 r/s, tối đa 64 kết nối mỗi IP), `PUT /u/<token>` (part upload ở chế độ proxy, tối đa 16 MiB, zone `chat_media_upload`), `/healthz`; còn lại 404. Không cookie hai chiều; access log ghi `/f/[token]` (log format `chat_media`), error log tắt cho hai location có token. File do app đọc và stream sau khi kiểm token (nginx không đọc thư mục media, không dùng `X-Accel-Redirect`). CSP của `chat.hoandat.com` cho phép `img-src`/`media-src`/`connect-src` tới `https://media-chat.hoandat.com` |
| Lưu media | Thư mục `/opt/chat/media` trên chính server (`MEDIA_ROOT`, `chat:chat` 0750, file 0640): `objects/` (file và các cỡ ảnh), `uploads/` (part của upload dở), `tmp/` (file đang ghi; ghi xong mới `fsync` và đổi tên). Tên file do server sinh (uuid), không lấy từ người dùng. Driver S3 (iNET Object Storage) vẫn có trong code, bật bằng `MEDIA_STORAGE=s3` khi chuyển |
| Realtime | WebSocket cùng origin `wss://chat.hoandat.com/ws`, qua Cloudflare (proxied, WebSocket bật sẵn, cắt kết nối im lặng sau 100 s; heartbeat của app là 25 s). Handshake kiểm `Origin` và cookie phiên như `/rpc`; giao thức ở [`server/README.md`](../server/README.md#realtime-ws) |
| Database | PostgreSQL 16.8 dùng chung của server (cổng 5432, chỉ localhost), database và role `chat` riêng (role `chat` là chủ database), hai dòng `pg_hba` scram-sha-256 của chat đặt trước các dòng `ident` chung. Cần gói `postgresql-contrib` cho extension `pg_trgm` của tìm kiếm (migration tự tạo, xem dưới) |
| Cấu hình | `/opt/chat/.env` (root:chat, 640), mẫu [`.env.production.example`](../infra/chat/.env.production.example); không bao giờ sync từ máy dev |
| Backup | [`backup-chat-db.sh`](../infra/chat/backup-chat-db.sh), cron 02:50 (`/etc/cron.d/chat-backup`), và trước mỗi lần kích hoạt release; giữ 14 bản trong `/opt/chat/backups` |
| Log | pm2 `/var/log/chat/api.{out,err}.log` (thư mục thuộc root vì daemon pm2 và cron backup chạy bằng root; pm2-logrotate của server xoay), nginx `/var/log/nginx/chat.hoandat.com.{access,error}.log`. Secret của webhook không có trong log nào: nginx ghi đường dẫn đã che, app chỉ ghi `hook_id` |

## Lần đầu (đã làm ngày 2026-10-14)

1. IdP: thêm `CHAT_WEB_URL` và `CHAT_WEB_CLIENT_SECRET` vào `/var/www/hoandat-auth/.env` (secret sinh trên server), deploy IdP theo `hoandat-auth/docs/deployment-guide.md`; cùng giá trị secret ghi vào `/opt/chat/.env` dưới tên `OIDC_CLIENT_SECRET`.
2. DNS `chat.hoandat.com` proxied.
3. Đồng bộ `infra/chat/` lên `/opt/chat/infra/`, chạy `bash /opt/chat/infra/issue-cert.sh` rồi `bash /opt/chat/infra/setup-server.sh` (user, thư mục, role/database Postgres, `pg_hba`, `SESSION_KEY`, `DATABASE_URL`, cron backup, conf nginx cấp http).
4. Deploy lần đầu như mục dưới.

Release R1 (nhắn tin realtime) đổi conf nginx (thêm `/ws`, CSP `wss:`). Deploy tự động không đổi được nginx (xem dưới), nên lần đầu lên R1 phải deploy bằng root một lần để đồng bộ `infra/chat/` (gồm `nginx/`); trước đó mọi lần deploy tự động của R1 sẽ trượt bước kiểm `/ws` của `activate-release.sh` và tự trở lại release trước.

Release sửa lỗi bảo mật sau R1 (migration `0004_messaging_hardening`) lại đổi conf nginx (zone `chat_ws` cho `/ws`, CSP cho SQLite wasm), nên cũng phải deploy bằng root một lần như trên; không cần cài lại `chat-http.conf`.

Release R2 (webhook, migration `0007_incoming_hooks`) đổi conf nginx (location `/hook/`, zone `chat_hook`, log format `chat_hook`), `activate-release.sh` (thêm bước kiểm `/hook/`) và `smoke.sh`, nên cũng phải deploy bằng root một lần. Không cần DNS mới, không cần chứng chỉ mới, không cần cài lại `chat-http.conf`, không có biến môi trường mới.

Bản bù R2 (sửa webhook, tin hệ thống khi webhook tắt, migration `0008_hook_audit_updated`) không đổi nginx hay biến môi trường, deploy như các lần sau. Từ bản này web gọi `GetSelf` bằng JSON của Connect (`Content-Type: application/json`) trên `/rpc/`; nếu sau này thêm lọc request ở nginx hay Cloudflare cho `/rpc/`, phải cho qua cả JSON lẫn `application/proto`.

Release R3 (media, migration `0009_media`) thêm conf nginx `media-chat.hoandat.com.conf`, đổi CSP của `chat.hoandat.com.conf`, `activate-release.sh` (tạo thư mục media, cài conf media khi có chứng chỉ, kiểm host media), `setup-server.sh` (thư mục media), `smoke.sh`, `ecosystem.config.cjs` (trần bộ nhớ 700 MB, `GOMEMLIMIT`) và thêm biến `MEDIA_*`, nên phải deploy bằng root một lần. Các bước của người vận hành ở [Media](#media-r3).

Release R4 (tìm kiếm tin nhắn, migration `0011_message_search`) không đổi nginx, script hay biến môi trường, deploy như các lần sau. Migration không tạo extension: Postgres của `.65` không cài contrib (`pg_available_extensions` không có `pg_trgm`, kiểm ngày 2026-10-15), nên chỉ mục dùng tsvector có sẵn. Sau migration, bước migrate đánh chỉ mục tìm kiếm cho các tin đã có (`search.Backfill`, đo trên máy dev: 200.000 tin trong khoảng 4 giây); chạy lại không làm gì thêm. Xem [server/README.md](../server/README.md#tìm-kiếm-tin-nhắn-package-internalsearch-r4).

Bản tìm kiếm chuỗi con (migration `0012_message_search_substring`: từ khoá khớp cả giữa từ, "uần" ra "tuần") không đổi nginx, script hay biến môi trường, deploy như các lần sau, nhưng **cần `pg_trgm`**:

- Điều kiện: gói `postgresql-contrib` đã cài trên server (người vận hành cài bản 16.8 ngày 2026-10-15; `SELECT name, default_version FROM pg_available_extensions WHERE name = 'pg_trgm'` trả `pg_trgm | 1.6`). Migration tự chạy `CREATE EXTENSION IF NOT EXISTS pg_trgm`. `pg_trgm` là extension trusted (Postgres ≥ 13), nên role `chat`, chủ database `chat`, tạo được mà không cần superuser; test `TestMigrateCreatesTrigramExtensionAsDatabaseOwner` chạy toàn bộ migration bằng một role chủ database không phải superuser.
- Nếu role chạy migrate không có quyền `CREATE` trên database, migration báo `permission denied to create extension "pg_trgm"` (SQLSTATE 42501, gợi ý "Must have CREATE privilege on current database to create this extension"); nếu thiếu contrib thì báo extension `pg_trgm` không có (`is not available`). Cả hai trường hợp: transaction của migration rollback, schema ở nguyên bản 0011, `activate-release.sh` dừng ở bước migrate trước khi đổi `current`, release cũ tiếp tục chạy. Cách xử lý: cài contrib, hoặc tạo extension bằng quyền admin một lần (`sudo -u postgres psql -d chat -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'`), rồi deploy lại; migration bỏ qua bước tạo vì extension đã có.
- Expand/contract: chỉ thêm cột `messages.search_text` (nullable) và GIN index trigram, giữ `search_tsv`. Binary R4 vẫn chạy trên schema mới (không đọc cột mới); tin nó ghi trong lúc chuyển có `search_text` `NULL`, chưa tìm được bằng chuỗi con cho tới lần `-role migrate` sau (backfill). Bước migrate của bản này điền `search_text` cho mọi tin cũ (`search.Backfill`, đo trên máy dev: 200.000 tin trong khoảng 6,4 giây, gồm cả cập nhật GIN index).
- Rollback code (`switch-release.sh`) về R4 không cần đụng dữ liệu. Down của migration bỏ index và cột, giữ extension. Backup `pg_dump` có thêm lệnh tạo extension; restore bằng role `chat` vẫn tạo được vì extension trusted.

## Các lần sau

Mặc định deploy tự động: mỗi lần `ci` xanh trên `main`, workflow [`deploy`](../.github/workflows/deploy.yml) build release trong một job không có key deploy, rồi job deploy tải lên `/opt/chat/incoming/<id>` bằng user `chat-deploy` rồi gọi lệnh sudo duy nhất user này có, `/usr/local/sbin/chat-activate-incoming <id>` ([`activate-incoming.sh`](../infra/chat/activate-incoming.sh)). Lệnh đó chuyển bản upload vào `/opt/chat/staging` (chỉ root), đổi chủ sang root rồi mới kiểm (từ chối symlink và file đặc biệt), chuyển sang `/opt/chat/releases`, thay conf nginx bằng bản trong `/opt/chat/infra/nginx` (bản upload không đổi được nginx), rồi chạy `activate-release.sh`; cuối cùng workflow chạy `smoke.sh`.

- User `chat-deploy`: tạo bằng `bash /opt/chat/infra/setup-deploy-user.sh < chat-deploy.pub` (key ed25519, `authorized_keys` có `restrict`; sudoers chỉ cho một lệnh và thêm `/usr/local/bin`, nơi có `pm2`, vào `secure_path` của riêng user này).
- GitHub secret: `CHAT_DEPLOY_SSH_KEY` (private key, nạp qua stdin của `gh secret set`, không lưu trên máy dev) và `CHAT_DEPLOY_KNOWN_HOSTS` (host key của server, cổng 24700).
- Script trong `/opt/chat/infra` (gồm cả bản cài cho sudo) chỉ đổi qua deploy bằng root bên dưới; khi sửa `infra/chat/` thì chạy deploy root một lần, rồi chạy lại `setup-deploy-user.sh < /dev/null` nếu `activate-incoming.sh` đổi.

Deploy bằng root từ gốc repo, key SSH qua thư mục tạm (cách nạp key ở skill `chat-ops-prod`):

```bash
SSH_TARGET=root@103.72.98.65 SSH_OPTS="-i <key> -p 24700 -o IdentitiesOnly=yes" bash infra/chat/deploy.sh
bash infra/chat/smoke.sh
```

`deploy.sh` build web và binary Linux trên máy dev, tải release lên, đồng bộ `infra/chat/`, rồi chạy [`activate-release.sh`](../infra/chat/activate-release.sh): backup DB, chạy migration bằng binary mới, cài conf nginx của release (`nginx -t` trước), đổi symlink, reload pm2 `chat-api`, chờ `/healthz`, rồi kiểm `/ws` trả 403 cho GET không có `Origin` và `POST /hook/` với hook không tồn tại trả JSON `hook_not_found`, cả trực tiếp ở `127.0.0.1:4600` lẫn qua nginx; lỗi ở bất kỳ bước nào sau khi đổi thì tự trở lại release trước. Migration chỉ thêm (expand), nên binary trước vẫn chạy được trên schema mới.

## Tài khoản vận hành (kiểm duyệt)

Hàng đợi kiểm duyệt (`ModerationService`) chỉ mở cho các user id ghi trong `CHAT_OPERATOR_USER_IDS` của `/opt/chat/.env`. Mặc định biến này không có, nên không ai là người vận hành. Cách cấp quyền:

1. Người được cấp đăng nhập chat một lần để có user. Lấy user id qua [`psql.sh`](../infra/chat/psql.sh): `SELECT id, username, name FROM users WHERE tenant_id = 'primary' AND username = '<username>';`.
2. Thêm vào `/opt/chat/.env` (nhiều id cách nhau bằng dấu phẩy, tối đa 100): `CHAT_OPERATOR_USER_IDS=<id>[,<id>…]`.
3. `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env` (process đọc lại `-env-file` khi khởi động); log khởi động ghi `operators=<số id>`. `GetSelf` của người đó trả `is_operator: true`.

Thu hồi: xoá id khỏi biến rồi reload. Mọi hành động kiểm duyệt (bỏ qua, xoá tin, cấm khỏi chat, khoá tài khoản chat, gỡ khoá) ghi vào bảng `moderation_log` chỉ cho thêm (trigger chặn sửa và xoá).

## Kiểm tra sau deploy

`infra/chat/smoke.sh`: `/` trả 200, `/healthz` báo `"db":"connected"`, `/auth/login` chuyển tới `auth.hoandat.com` với `client_id=chat-web`, `GetSelf` không có phiên trả 401, `/ws` không có phiên trả 401, `POST /hook/` với hook không tồn tại trả `hook_not_found`; khi đã cấu hình media: `https://media-chat.hoandat.com/healthz` báo `"storage":"reachable"`, `/f/<token sai>` trả 404 có `nosniff` và không `Set-Cookie`, route của app trên host media trả 404 (chưa cấu hình thì bỏ qua và in thông báo). Sau đó đăng nhập thật trên trình duyệt và xem `pm2 describe chat-api` (số `restarts` không tăng).

## Webhook (incoming)

- Admin nhóm hoặc kênh tạo webhook qua `IntegrationsService` (giao thức ở [`server/README.md`](../server/README.md#webhook-incoming-package-internalhooks)). URL dạng `https://chat.hoandat.com/hook/<hook_id>/<secret>[/slack|/alertmanager|/grafana|/gitlab]`, chỉ hiện một lần; DB chỉ giữ SHA-256 của secret.
- Tra cứu khi có người báo "cảnh báo không về" (qua [`psql.sh`](../infra/chat/psql.sh), không bao giờ cần secret):
  - trạng thái: `SELECT id, chat_id, name, format, state, disabled_reason, last_used_at FROM incoming_hooks WHERE id = '<hook_id>';` (`auto_disabled` là người tạo đã mất quyền admin; admin khác nhận lại trong app);
  - request lỗi gần đây: `SELECT created_at, reason, detail, http_status FROM hook_dead_letters WHERE hook_id = '<hook_id>' ORDER BY id DESC LIMIT 20;`;
  - bộ đếm theo giờ: `SELECT * FROM hook_counters WHERE hook_id = '<hook_id>' ORDER BY hour DESC LIMIT 24;` và `hook_failures` (lý do lỗi, kể cả `rate_limited`);
  - lịch sử quản lý: `SELECT * FROM hook_audit WHERE hook_id = '<hook_id>' ORDER BY id;` (bảng chỉ thêm, trigger chặn sửa và xoá).
- URL lộ: admin xoay secret trong app với "thu hồi ngay", hoặc tắt webhook. Người vận hành tắt khẩn cấp: `UPDATE incoming_hooks SET state = 'disabled', disabled_reason = 'by_admin', disabled_at = now() WHERE id = '<hook_id>';` (có hiệu lực ở request kế tiếp).
- Dọn mỗi giờ: khoá idempotency quá 24 giờ; nhóm cảnh báo (`notify_groups`), bộ đếm và dead letter quá 30 ngày.

## Media (R3)

Giao thức và giới hạn ở [`server/README.md`](../server/README.md#media-package-internalmedia). Chưa có `MEDIA_PUBLIC_URL` trong `/opt/chat/.env` thì media tắt: app chạy bình thường, `AppConfig.upload_size_max_bytes = 0` nên client ẩn nút đính kèm, RPC media trả `failed_precondition` `media_disabled`.

Media lưu trên chính server `.65` (Jev quyết 2026-10-15): upload đi qua API của app (từng part 8 MiB `PUT https://media-chat.hoandat.com/u/<token>`, tiếp tục được), không có URL S3 ký sẵn, không cần CORS; tải xuống do app stream có Range tại `MEDIA_PUBLIC_URL`.

Bật media (một lần):

1. DNS `media-chat.hoandat.com` proxied và chứng chỉ ở `/etc/letsencrypt/live/media-chat.hoandat.com/` (đã có từ 2026-10-15), gia hạn bằng timer certbot như chứng chỉ của chat. Cloudflare để SSL "Full (strict)".
2. Thêm khối `MEDIA_*` của [`.env.production.example`](../infra/chat/.env.production.example) vào `/opt/chat/.env`: `MEDIA_PUBLIC_URL`, `MEDIA_ROOT=/opt/chat/media`, `MEDIA_MIN_FREE_BYTES` (mặc định 5 GiB), `MEDIA_UPLOAD_MAX_BYTES=536870912` (512 MiB cho server dùng chung; code mặc định 2000 MiB), `MEDIA_USER_QUOTA_BYTES` (mẫu 10 GiB; code mặc định 20 GiB).
3. Tuỳ chọn: `apt install ffmpeg` rồi `MEDIA_FFMPEG_PATH=/usr/bin/ffmpeg` để server tạo poster video và waveform voice (ffmpeg đọc file cục bộ, chỉ được dùng giao thức `file`); không có thì dùng thumb, thời lượng và waveform client gửi.
4. Deploy bằng root (để có conf nginx media và thư mục `/opt/chat/media`), hoặc nếu release đã có thì `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`. Kiểm: `curl -s https://media-chat.hoandat.com/healthz` trả `{"status":"ok","storage":"reachable"}`, rồi `bash infra/chat/smoke.sh`.

Vận hành:
- Dung lượng đĩa: app từ chối upload mới (`resource_exhausted` "server storage is full") và log `Error` `media disk almost full` khi upload làm chỗ trống trên đĩa của `MEDIA_ROOT` còn dưới `MEDIA_MIN_FREE_BYTES`; việc dọn mỗi 10 phút cũng log dòng này khi đĩa đã dưới ngưỡng. Xem nhanh: `df -h /opt/chat/media`, `du -sh /opt/chat/media/objects`.
- Dọn trong app mỗi 10 phút: upload dở quá 24 giờ bị huỷ (xoá part và file staging), file tạm sót lại quá 24 giờ bị xoá, file không còn tin nào và không còn xem trước link nào tham chiếu quá 24 giờ bị xoá cả bản gốc lẫn các cỡ. Tra cứu qua [`psql.sh`](../infra/chat/psql.sh): `SELECT count(*), pg_size_pretty(sum(size)) FROM files;`, `SELECT count(*) FROM uploads WHERE completed_at IS NULL;`, `SELECT * FROM media_jobs;`.
- Thu hồi: xoá tin cho mọi người làm URL tải của file trong tin đó trả 404 trong vòng 5 giây (app) và tối đa 50 giây nếu CDN đã cache (`s-maxage=50`). Cloudflare chỉ cache khi có Cache Rule cho host media (mặc định không cache vì URL không có đuôi file); bật thì giữ "Respect origin TTL".
- Người dùng báo "ảnh không tải được": URL hết hạn sau khoảng một giờ (403, client tự xin URL mới); 404 là tin đã bị xoá hoặc người xem không còn quyền. Log của app ghi `media storage unreachable` khi thư mục media không ghi được.
- Backup: dump DB hằng đêm như cũ; sao lưu media ra ngoài server để sau, khi có người dùng thật (Jev quyết 2026-10-15).
- Chuyển sang S3 sau này: `MEDIA_STORAGE=s3` cùng `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (mẫu trong env). Identity chỉ cần `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:AbortMultipartUpload`. `MEDIA_UPLOAD_MODE=proxy` chạy ngay; `direct` (trình duyệt PUT thẳng tới storage) cần người có quyền cấu hình bucket đặt CORS (`AllowedOrigins` `https://chat.hoandat.com`, `AllowedMethods` `PUT`, `AllowedHeaders` `*`, `ExposeHeaders` `ETag`) và thêm origin storage vào CSP `connect-src`. File đã có trên đĩa phải được chép sang bucket trước khi đổi: `objects/<p>/<xx>/<tên>` thành key `<p>/<tên>` (bỏ thư mục chia nhỏ `<xx>`, hai ký tự đầu của tên).

## Bảo mật mạng

- Xem trước link do server tải trang người dùng dán, nên site đích thấy IP gốc `103.72.98.65` (và biết server đứng sau Cloudflare). Việc vận hành cần làm: chặn cổng 443/80 của server với mọi nguồn trừ dải IP của Cloudflare (`https://www.cloudflare.com/ips/`), để biết IP gốc cũng không vượt được Cloudflare. Chưa làm trong repo này vì firewall của server dùng chung với các app khác.

## Rollback

- Media: release trước R3 bỏ qua các bảng media; file trong `/opt/chat/media` giữ nguyên. Tắt media mà không rollback: xoá `MEDIA_PUBLIC_URL` khỏi `/opt/chat/.env` rồi reload (tin có media vẫn hiển thị thumb trong tin, nhưng không tải được bản đầy đủ).
- Code: `bash /opt/chat/infra/switch-release.sh <release-id>` (danh sách: `ls /opt/chat/releases`). Không đảo ngược dữ liệu.
- Dữ liệu: dừng `chat-api`, `pg_restore --clean --if-exists` từ bản trong `/opt/chat/backups` với kết nối từ `pg-env.sh`, **tăng `server_epoch`** (`UPDATE server_meta SET server_epoch = server_epoch + 1;` qua [`psql.sh`](../infra/chat/psql.sh)), rồi chạy lại. Bản restore làm `pts`/`seq` lùi về lúc backup; epoch mới báo cho client rằng vị trí đồng bộ của nó không còn đúng, để client tự đồng bộ lại thay vì bỏ sót tin (ADR 0002). Process đang chạy đọc lại epoch mỗi 30 giây và yêu cầu mọi socket kết nối lại.

## Dữ liệu đồng bộ

- Nhật ký update theo người dùng (`user_updates`), theo chat lớn (`chat_updates`) và `outbox` chia partition theo ngày UTC. `chat-api` tạo trước partition cho 30 ngày tới khi khởi động và mỗi giờ (hàm SQL `chat_create_day_partitions`, transaction riêng, `lock_timeout` 5 giây) và log `Warn` `log partitions cover fewer days ahead than expected` khi còn dưới 7 ngày phía trước: thấy dòng này là phải xử lý trước khi ghi tin bị lỗi. Partition cũ hơn 30 ngày được tách bằng `DETACH PARTITION … CONCURRENTLY` rồi `DROP TABLE`, mỗi câu một transaction (không giữ khoá chặn ghi trên bảng cha). Nếu `chat-api` dừng quá 30 ngày thì phải chạy `SELECT chat_create_day_partitions(30);` (qua `psql.sh`) trước khi ghi tin.
- Rollback code về release **trước migration 0003** (trước R1) chỉ an toàn dưới 30 ngày: binary cũ không tạo partition, nên khi hết partition đã tạo trước thì mọi lần ghi `outbox` lỗi, kể cả trigger thu hồi phiên (đăng xuất, thu hồi phiên sẽ lỗi). Nếu phải ở lại bản đó lâu hơn, chạy `SELECT chat_create_day_partitions(30);` hằng ngày (cron) cho tới khi lên lại. Release từ 0003 trở đi dùng được trên schema 0004 (expand-only; binary R1 vẫn gọi `chat_ensure_day_partitions`, hàm này được giữ nguyên).
- Mỗi giờ: xoá `send_dedupe` cũ hơn 7 ngày, cache xem trước link cũ hơn 7 ngày, `jti` logout đã hết hạn.
- Số worker Snowflake (khoá tin nội bộ) được thuê trong bảng `snowflake_workers` (gia hạn mỗi 15 giây, hết hạn sau 60 giây), nên hai process không bao giờ cấp trùng khoá.
