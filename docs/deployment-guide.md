# Deploy chat (chat.hoandat.com)

Giai đoạn 1 của hạ tầng: app chat chạy chung server `103.72.98.65` với IdP, Localman và các app khác, theo quy ước của server đó (pm2, nginx một file mỗi host, không Docker Compose). Vận hành hằng ngày qua skill [`chat-ops-prod`](../.claude/skills/chat-ops-prod/SKILL.md). Khi tải chạm ngưỡng thì chuyển lên cụm riêng (plan, Phase 13 giai đoạn 2).

## Thành phần

| Thành phần | Vị trí |
|---|---|
| DNS (Cloudflare, zone `hoandat.com`) | `chat` → `103.72.98.65`, proxied. `*.chat` (bot, hook) thêm khi có release cần |
| TLS | Let's Encrypt `chat.hoandat.com` + `*.chat.hoandat.com`, DNS-01 Cloudflare với token Zone:DNS:Edit đã có trên server (`/etc/letsencrypt/cloudflare-localman.ini`), gia hạn bằng timer certbot kèm `systemctl reload nginx` ([`issue-cert.sh`](../infra/chat/issue-cert.sh)) |
| Release | `/opt/chat/releases/<id>/{server,web,nginx}`, id = giờ UTC + commit 12 ký tự (+`-dirty`), symlink `/opt/chat/current`; giữ 5 bản |
| Process | pm2 `chat-api` ([`ecosystem.config.cjs`](../infra/chat/ecosystem.config.cjs)), một instance, user hệ thống `chat`, binary Go tĩnh `server -role api -env-file /opt/chat/.env`, nghe `127.0.0.1:4600`, restart khi vượt 300 MB. Gateway realtime (WebSocket `/ws`) chạy trong chính process này, không có process hay cổng riêng |
| nginx | `/etc/nginx/conf.d/chat-http.conf` (log format bỏ query, zone rate limit; cài một lần) và `/etc/nginx/conf.d/chat.hoandat.com.conf` (mỗi release mang bản của nó, [`nginx/`](../infra/chat/nginx/)). Web tĩnh từ `current/web`, `/rpc/` và `/auth/` tới API, `/ws` tới API với header `Upgrade`/`Connection` (timeout đọc 75 s, rate limit handshake theo zone riêng `chat_ws` 10 r/s, burst 200, khai báo ngay trong conf của site nên không phải cài lại `chat-http.conf`; đừng khai báo `chat_ws` lần nữa ở `chat-http.conf`), `/healthz` công khai. CSP `connect-src` có `wss://chat.hoandat.com`; `script-src` có `'wasm-unsafe-eval'` và có `worker-src 'self'` (SQLite wasm với OPFS chạy trong worker cùng origin) |
| Realtime | WebSocket cùng origin `wss://chat.hoandat.com/ws`, qua Cloudflare (proxied, WebSocket bật sẵn, cắt kết nối im lặng sau 100 s; heartbeat của app là 25 s). Handshake kiểm `Origin` và cookie phiên như `/rpc`; giao thức ở [`server/README.md`](../server/README.md#realtime-ws) |
| Database | PostgreSQL 16.8 dùng chung của server (cổng 5432, chỉ localhost), database và role `chat` riêng, hai dòng `pg_hba` scram-sha-256 của chat đặt trước các dòng `ident` chung |
| Cấu hình | `/opt/chat/.env` (root:chat, 640), mẫu [`.env.production.example`](../infra/chat/.env.production.example); không bao giờ sync từ máy dev |
| Backup | [`backup-chat-db.sh`](../infra/chat/backup-chat-db.sh), cron 02:50 (`/etc/cron.d/chat-backup`), và trước mỗi lần kích hoạt release; giữ 14 bản trong `/opt/chat/backups` |
| Log | pm2 `/var/log/chat/api.{out,err}.log` (thư mục thuộc root vì daemon pm2 và cron backup chạy bằng root; pm2-logrotate của server xoay), nginx `/var/log/nginx/chat.hoandat.com.{access,error}.log` |

## Lần đầu (đã làm ngày 2026-10-14)

1. IdP: thêm `CHAT_WEB_URL` và `CHAT_WEB_CLIENT_SECRET` vào `/var/www/hoandat-auth/.env` (secret sinh trên server), deploy IdP theo `hoandat-auth/docs/deployment-guide.md`; cùng giá trị secret ghi vào `/opt/chat/.env` dưới tên `OIDC_CLIENT_SECRET`.
2. DNS `chat.hoandat.com` proxied.
3. Đồng bộ `infra/chat/` lên `/opt/chat/infra/`, chạy `bash /opt/chat/infra/issue-cert.sh` rồi `bash /opt/chat/infra/setup-server.sh` (user, thư mục, role/database Postgres, `pg_hba`, `SESSION_KEY`, `DATABASE_URL`, cron backup, conf nginx cấp http).
4. Deploy lần đầu như mục dưới.

Release R1 (nhắn tin realtime) đổi conf nginx (thêm `/ws`, CSP `wss:`). Deploy tự động không đổi được nginx (xem dưới), nên lần đầu lên R1 phải deploy bằng root một lần để đồng bộ `infra/chat/` (gồm `nginx/`); trước đó mọi lần deploy tự động của R1 sẽ trượt bước kiểm `/ws` của `activate-release.sh` và tự trở lại release trước.

Release sửa lỗi bảo mật sau R1 (migration `0004_messaging_hardening`) lại đổi conf nginx (zone `chat_ws` cho `/ws`, CSP cho SQLite wasm), nên cũng phải deploy bằng root một lần như trên; không cần cài lại `chat-http.conf`.

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

`deploy.sh` build web và binary Linux trên máy dev, tải release lên, đồng bộ `infra/chat/`, rồi chạy [`activate-release.sh`](../infra/chat/activate-release.sh): backup DB, chạy migration bằng binary mới, cài conf nginx của release (`nginx -t` trước), đổi symlink, reload pm2 `chat-api`, chờ `/healthz`, rồi kiểm `/ws` trả 403 cho GET không có `Origin`, cả trực tiếp ở `127.0.0.1:4600` lẫn qua nginx; lỗi ở bất kỳ bước nào sau khi đổi thì tự trở lại release trước. Migration chỉ thêm (expand), nên binary trước vẫn chạy được trên schema mới.

## Tài khoản vận hành (kiểm duyệt)

Hàng đợi kiểm duyệt (`ModerationService`) chỉ mở cho các user id ghi trong `CHAT_OPERATOR_USER_IDS` của `/opt/chat/.env`. Mặc định biến này không có, nên không ai là người vận hành. Cách cấp quyền:

1. Người được cấp đăng nhập chat một lần để có user. Lấy user id qua [`psql.sh`](../infra/chat/psql.sh): `SELECT id, username, name FROM users WHERE tenant_id = 'primary' AND username = '<username>';`.
2. Thêm vào `/opt/chat/.env` (nhiều id cách nhau bằng dấu phẩy, tối đa 100): `CHAT_OPERATOR_USER_IDS=<id>[,<id>…]`.
3. `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env` (process đọc lại `-env-file` khi khởi động); log khởi động ghi `operators=<số id>`. `GetSelf` của người đó trả `is_operator: true`.

Thu hồi: xoá id khỏi biến rồi reload. Mọi hành động kiểm duyệt (bỏ qua, xoá tin, cấm khỏi chat, khoá tài khoản chat, gỡ khoá) ghi vào bảng `moderation_log` chỉ cho thêm (trigger chặn sửa và xoá).

## Kiểm tra sau deploy

`infra/chat/smoke.sh`: `/` trả 200, `/healthz` báo `"db":"connected"`, `/auth/login` chuyển tới `auth.hoandat.com` với `client_id=chat-web`, `GetSelf` không có phiên trả 401, `/ws` không có phiên trả 401. Sau đó đăng nhập thật trên trình duyệt và xem `pm2 describe chat-api` (số `restarts` không tăng).

## Bảo mật mạng

- Xem trước link do server tải trang người dùng dán, nên site đích thấy IP gốc `103.72.98.65` (và biết server đứng sau Cloudflare). Việc vận hành cần làm: chặn cổng 443/80 của server với mọi nguồn trừ dải IP của Cloudflare (`https://www.cloudflare.com/ips/`), để biết IP gốc cũng không vượt được Cloudflare. Chưa làm trong repo này vì firewall của server dùng chung với các app khác.

## Rollback

- Code: `bash /opt/chat/infra/switch-release.sh <release-id>` (danh sách: `ls /opt/chat/releases`). Không đảo ngược dữ liệu.
- Dữ liệu: dừng `chat-api`, `pg_restore --clean --if-exists` từ bản trong `/opt/chat/backups` với kết nối từ `pg-env.sh`, **tăng `server_epoch`** (`UPDATE server_meta SET server_epoch = server_epoch + 1;` qua [`psql.sh`](../infra/chat/psql.sh)), rồi chạy lại. Bản restore làm `pts`/`seq` lùi về lúc backup; epoch mới báo cho client rằng vị trí đồng bộ của nó không còn đúng, để client tự đồng bộ lại thay vì bỏ sót tin (ADR 0002). Process đang chạy đọc lại epoch mỗi 30 giây và yêu cầu mọi socket kết nối lại.

## Dữ liệu đồng bộ

- Nhật ký update theo người dùng (`user_updates`), theo chat lớn (`chat_updates`) và `outbox` chia partition theo ngày UTC. `chat-api` tạo trước partition cho 30 ngày tới khi khởi động và mỗi giờ (hàm SQL `chat_create_day_partitions`, transaction riêng, `lock_timeout` 5 giây) và log `Warn` `log partitions cover fewer days ahead than expected` khi còn dưới 7 ngày phía trước: thấy dòng này là phải xử lý trước khi ghi tin bị lỗi. Partition cũ hơn 30 ngày được tách bằng `DETACH PARTITION … CONCURRENTLY` rồi `DROP TABLE`, mỗi câu một transaction (không giữ khoá chặn ghi trên bảng cha). Nếu `chat-api` dừng quá 30 ngày thì phải chạy `SELECT chat_create_day_partitions(30);` (qua `psql.sh`) trước khi ghi tin.
- Rollback code về release **trước migration 0003** (trước R1) chỉ an toàn dưới 30 ngày: binary cũ không tạo partition, nên khi hết partition đã tạo trước thì mọi lần ghi `outbox` lỗi, kể cả trigger thu hồi phiên (đăng xuất, thu hồi phiên sẽ lỗi). Nếu phải ở lại bản đó lâu hơn, chạy `SELECT chat_create_day_partitions(30);` hằng ngày (cron) cho tới khi lên lại. Release từ 0003 trở đi dùng được trên schema 0004 (expand-only; binary R1 vẫn gọi `chat_ensure_day_partitions`, hàm này được giữ nguyên).
- Mỗi giờ: xoá `send_dedupe` cũ hơn 7 ngày, cache xem trước link cũ hơn 7 ngày, `jti` logout đã hết hạn.
- Số worker Snowflake (khoá tin nội bộ) được thuê trong bảng `snowflake_workers` (gia hạn mỗi 15 giây, hết hạn sau 60 giây), nên hai process không bao giờ cấp trùng khoá.
