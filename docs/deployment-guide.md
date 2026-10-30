# Deploy chat (chat.hoandat.com)

Giai đoạn 1 của hạ tầng: app chat chạy chung server `<SERVER_65_IP>` với IdP, Localman và các app khác, theo quy ước của server đó (pm2, nginx một file mỗi host, không Docker Compose). Vận hành hằng ngày qua skill [`chat-ops-prod`](../.claude/skills/chat-ops-prod/SKILL.md). Khi tải chạm ngưỡng thì chuyển lên cụm riêng (plan, Phase 13 giai đoạn 2).

## Thành phần

| Thành phần | Vị trí |
|---|---|
| DNS (Cloudflare, zone `hoandat.com`) | `chat` → `<SERVER_65_IP>`, proxied. Webhook không cần bản ghi riêng: nằm ở `https://chat.hoandat.com/hook/…`, vì Universal SSL miễn phí của Cloudflare chỉ phủ `*.hoandat.com`, không phủ host cấp hai như `hook.chat.hoandat.com` (quyết định 2026-10-15). `*.chat` (bot) thêm khi có release cần. `media-chat` → `<SERVER_65_IP>`, proxied: host media tạm thời (R3), host cấp một nên Universal SSL phủ được; trước R9 chuyển sang domain đăng ký riêng (ADR 0010) |
| TLS | Let's Encrypt `chat.hoandat.com` + `*.chat.hoandat.com`, DNS-01 Cloudflare với token Zone:DNS:Edit đã có trên server (`/etc/letsencrypt/cloudflare-localman.ini`), gia hạn bằng timer certbot kèm `systemctl reload nginx` ([`issue-cert.sh`](../infra/chat/issue-cert.sh)). Chứng chỉ trên không phủ `media-chat.hoandat.com`: host này có chứng chỉ Let's Encrypt riêng ở `/etc/letsencrypt/live/media-chat.hoandat.com/` |
| Release | `/opt/chat/releases/<id>/{server,web,nginx}`, id = giờ UTC + commit 12 ký tự (+`-dirty`), symlink `/opt/chat/current`; giữ 5 bản |
| Process | pm2 `chat-api` ([`ecosystem.config.cjs`](../infra/chat/ecosystem.config.cjs)), một instance, user hệ thống `chat`, binary Go tĩnh `server -role api -env-file /opt/chat/.env`, nghe `127.0.0.1:4600`, restart khi vượt 700 MB (`GOMEMLIMIT=450MiB`; ảnh được giải mã trong process với ngân sách 256 MiB, xem [Media](#media-r3)). Gateway realtime (WebSocket `/ws`) chạy trong chính process này, không có process hay cổng riêng |
| nginx | `/etc/nginx/conf.d/chat-http.conf` (log format bỏ query, zone rate limit; cài một lần) và `/etc/nginx/conf.d/chat.hoandat.com.conf` (mỗi release mang bản của nó, [`nginx/`](../infra/chat/nginx/)). Web tĩnh từ `current/web`, `/rpc/` và `/auth/` tới API, `/ws` tới API với header `Upgrade`/`Connection` (timeout đọc 75 s, rate limit handshake theo zone riêng `chat_ws` 10 r/s, burst 200, khai báo ngay trong conf của site nên không phải cài lại `chat-http.conf`; đừng khai báo `chat_ws` lần nữa ở `chat-http.conf`), `/healthz` công khai. `/hook/` (webhook) chỉ nhận `POST`, tới API không kèm cookie, zone rate limit riêng `chat_hook` 50 r/s mỗi IP (burst 200, khai báo trong conf của site như `chat_ws`), body tối đa 128 KiB ở nginx (app giới hạn 64 KiB và tự trả 413 để còn đếm), access log ghi `/hook/<id>/[redacted]` thay cho đường dẫn chứa secret (log format `chat_hook`), error log của nginx tắt cho location này vì nginx chép dòng request vào đó. CSP `connect-src` có `wss://chat.hoandat.com`; `script-src` có `'wasm-unsafe-eval'` và hash `sha256` của script theme inline trong `index.html` (script chung của `@achoo254/app-shell`, đặt `data-theme` trước lần vẽ đầu; nâng gói mà script đổi thì `apps/web/test/theme-bootstrap.test.ts` báo lỗi và in hash mới cho cả bốn chỗ `script-src`); thêm hash của script ngôn ngữ inline (`apps/web/vite-lang-bootstrap.ts`, đặt `<html lang>` theo lựa chọn chung để màn chờ nói đúng tiếng; script đổi thì `apps/web/test/lang-bootstrap.test.ts` in hash mới); beacon Cloudflare Web Analytics (Cloudflare tự chèn, không cookie, trang quyền riêng tư có ghi) được `script-src https://static.cloudflareinsights.com` và `connect-src https://cloudflareinsights.com` và có `worker-src 'self'` (SQLite wasm với OPFS chạy trong worker cùng origin) |
| nginx media | `/etc/nginx/conf.d/media-chat.hoandat.com.conf` ([bản trong repo](../infra/chat/nginx/media-chat.hoandat.com.conf)), chỉ được cài khi chứng chỉ của host đã có. Chỉ mở `GET/HEAD /f/<token>` (tải, Range, không buffer, zone `chat_media` 100 r/s, tối đa 64 kết nối mỗi IP), `PUT /u/<token>` (part upload ở chế độ proxy, tối đa 16 MiB, zone `chat_media_upload`), `/healthz`; còn lại 404. Không cookie hai chiều; access log ghi `/f/[token]` (log format `chat_media`), error log tắt cho hai location có token. File do app đọc và stream sau khi kiểm token (nginx không đọc thư mục media, không dùng `X-Accel-Redirect`). CSP của `chat.hoandat.com` cho phép `img-src`/`media-src`/`connect-src` tới `https://media-chat.hoandat.com`; `img-src` thêm `https://lh3.googleusercontent.com` và `https://avatars.githubusercontent.com` cho ảnh tài khoản IdP (Google, GitHub) trên nút menu tài khoản |
| Lưu media | Thư mục `/opt/chat/media` trên chính server (`MEDIA_ROOT`, `chat:chat` 0750, file 0640): `objects/` (file và các cỡ ảnh), `uploads/` (part của upload dở), `tmp/` (file đang ghi; ghi xong mới `fsync` và đổi tên). Tên file do server sinh (uuid), không lấy từ người dùng. Driver S3 (iNET Object Storage) vẫn có trong code, bật bằng `MEDIA_STORAGE=s3` khi chuyển |
| Realtime | WebSocket cùng origin `wss://chat.hoandat.com/ws`, qua Cloudflare (proxied, WebSocket bật sẵn, cắt kết nối im lặng sau 100 s; heartbeat của app là 25 s). Handshake kiểm `Origin` và cookie phiên như `/rpc`; giao thức ở [`server/README.md`](../server/README.md#realtime-ws) |
| Database | PostgreSQL 16.8 dùng chung của server (cổng 5432, chỉ localhost), database và role `chat` riêng (role `chat` là chủ database), hai dòng `pg_hba` scram-sha-256 của chat đặt trước các dòng `ident` chung. Cần gói `postgresql-contrib` cho extension `pg_trgm` của tìm kiếm (migration tự tạo, xem dưới) |
| Cấu hình | `/opt/chat/.env` (root:chat, 640), mẫu [`.env.production.example`](../infra/chat/.env.production.example); không bao giờ sync từ máy dev |
| Backup | [`backup-chat-db.sh`](../infra/chat/backup-chat-db.sh), cron 02:50 (`/etc/cron.d/chat-backup`), và trước mỗi lần kích hoạt release; giữ 14 bản trong `/opt/chat/backups` |
| Log | pm2 `/var/log/chat/api.{out,err}.log` (thư mục thuộc root vì daemon pm2 và cron backup chạy bằng root; pm2-logrotate của server xoay), nginx `/var/log/nginx/chat.hoandat.com.{access,error}.log`. Secret của webhook không có trong log nào: nginx ghi đường dẫn đã che, app chỉ ghi `hook_id` |

## Lần đầu

1. IdP: thêm `CHAT_WEB_URL` và `CHAT_WEB_CLIENT_SECRET` vào `/var/www/hoandat-auth/.env` (secret sinh trên server), deploy IdP theo `auth-next/docs/deployment-guide.md`; cùng giá trị secret ghi vào `/opt/chat/.env` dưới tên `OIDC_CLIENT_SECRET`.
2. DNS `chat.hoandat.com` proxied.
3. Đồng bộ `infra/chat/` lên `/opt/chat/infra/`, chạy `bash /opt/chat/infra/issue-cert.sh` rồi `bash /opt/chat/infra/setup-server.sh` (user, thư mục, role/database Postgres, `pg_hba`, `SESSION_KEY`, `DATABASE_URL`, cron backup, conf nginx cấp http).
4. Deploy lần đầu như mục dưới.

Deploy tự động không đổi được conf nginx hay script trong `/opt/chat/infra` (xem [Các lần sau](#các-lần-sau)). Release nào đổi `infra/chat/` (conf nginx và CSP, `activate-release.sh`, `smoke.sh`, `ecosystem.config.cjs`, `setup-server.sh`, file mới như `sw-kill-switch.js`) thì **phải deploy bằng root một lần**; trước đó deploy tự động dùng conf và script cũ, nên route mới rơi vào web tĩnh hoặc bước kiểm của `activate-release.sh` trượt và tự trở lại release trước. Release chỉ đổi code và migration thì deploy như các lần sau.

### Ràng buộc lâu dài

- Migration chỉ thêm (expand): binary trước vẫn chạy trên schema mới, nên rollback code (`switch-release.sh`) không cần đụng dữ liệu.
- Tìm kiếm chuỗi con cần extension `pg_trgm` (gói `postgresql-contrib`). Migration tự chạy `CREATE EXTENSION IF NOT EXISTS pg_trgm` bằng role `chat`: extension trusted (Postgres ≥ 13), chủ database tạo được mà không cần superuser. Thiếu contrib (`is not available`) hoặc thiếu quyền `CREATE` trên database (SQLSTATE 42501) thì transaction của migration rollback, `activate-release.sh` dừng ở bước migrate trước khi đổi `current`, release cũ chạy tiếp. Xử lý: cài contrib, hoặc tạo extension bằng quyền admin một lần (`sudo -u postgres psql -d chat -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'`), rồi deploy lại.
- Web gọi `/rpc/` bằng cả JSON của Connect (`Content-Type: application/json`) lẫn `application/proto`; thêm lọc request ở nginx hay Cloudflare cho `/rpc/` thì phải cho qua cả hai.
- `OUTBOUND_DENY_CIDRS` phải đặt ở production (`OUTBOUND_DENY_CIDRS=<SERVER_65_IP>` trong `/opt/chat/.env`): IP hoặc dải CIDR mà webhook của bot và xem trước link không bao giờ gọi tới. Thiếu biến thì server vẫn chạy và vẫn chặn địa chỉ công khai trên network interface của máy, nhưng URL webhook trỏ thẳng vào `.65` (bản ghi DNS không proxy của app khác cùng máy) đi ra từ chính `.65`, qua được luật "chỉ IP Cloudflare" và các `allow <IP server>` của vhost khác. Kiểm log khởi động `outbound requests refuse these ranges` có `<SERVER_65_IP>/32`.
- `BOT_WEBHOOK_ALLOW_LOCAL` chỉ dùng khi `CHAT_ENV=development`; đặt ở production thì server không khởi động.
- Cấp lại token, xoá bot và đặt hay đổi webhook ở Developer Console cần đăng nhập IdP trong 10 phút gần đây (ADR 0006): web gửi `/auth/login?reauth=1`, server gửi `prompt=login` và `max_age=600` rồi lưu `auth_time` của ID token vào phiên mới. IdP không trả `auth_time` thì mọi thao tác đó trả `reauth_required`.
- Secret webhook của bot mã hoá bằng `SESSION_KEY`; khoá ký init data của Mini App và khoá mã xác nhận của MCP dẫn xuất từ khoá này. Đổi `SESSION_KEY` theo [runbook xoay vòng khoá](./operations/key-rotation.md); bỏ khoá cũ mà không qua runbook thì mỗi lần giao webhook lỗi `secret_unreadable` tới khi chủ bot lưu lại webhook.
- Bot Trợ lý: khi khởi động, `chat-api` tạo hoặc cập nhật bot `tro_ly_bot` (tên `<shortName> Trợ lý` lấy từ `brand.config.json`, bản sao `server/internal/brand/brand.json` sinh bằng `pnpm brand:gen`), log `assistant bot ready`. Một tài khoản đã giữ username đó thì app vẫn chạy nhưng không có Trợ lý, log `assistant bot is off: another account holds its username`; đổi username tài khoản đó rồi reload. Góp ý gửi Trợ lý chỉ đọc được khi đặt `CHAT_OPERATOR_USER_IDS` ([Tài khoản vận hành](#tài-khoản-vận-hành-kiểm-duyệt)).
- App iOS/Android đổi code qua location `= /rpc/app.v1.AuthService/ExchangeNativeCode` (zone `chat_auth`) của `chat.hoandat.com.conf`; `NATIVE_SIGN_IN` mặc định `on`.
- Mini App cần `frame-src https:` trong CSP của `chat.hoandat.com.conf`; thiếu thì trình duyệt chặn mọi iframe Mini App (app vẫn chạy).
- MCP ([ADR 0012](./adr/0012-mcp-endpoint.md)): resource là `CHAT_PUBLIC_URL` + `/mcp`. IdP phải chạy bản có resource `https://chat.hoandat.com/mcp` (`auth-next`, `CHAT_MCP_SCOPES`) trước, nếu không client MCP nhận `invalid_target` khi xin token. Kiểm sau deploy: `curl -s https://chat.hoandat.com/.well-known/oauth-protected-resource/mcp` trả JSON có `resource` đúng, `curl -si -X POST https://chat.hoandat.com/mcp` trả `401` kèm `WWW-Authenticate: Bearer … resource_metadata="…"`.
- Một tenant ([ADR 0013 Đơn tenant](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md) của `auth-next`): server không đọc `TENANT_ID` (tenant luôn `primary`, dữ liệu không đổi), `TENANT_DOMAIN` giữ nguyên.
- Service worker: `/sw.js` và `index.html` phải trả `Cache-Control: no-cache` (nếu không trình duyệt giữ worker cũ lâu hơn), CSP phải có `worker-src 'self'`. Rollback về release không có `sw.js` cần kill switch ([Rollback](#rollback)).

Bản ghi deploy cũ: git log của file này.

## Các lần sau

Mặc định deploy tự động: mỗi lần `ci` xanh trên `main`, workflow [`deploy`](../.github/workflows/deploy.yml) build release trong một job không có key deploy, rồi job deploy tải lên `/opt/chat/incoming/<id>` bằng user `chat-deploy` rồi gọi lệnh sudo duy nhất user này có, `/usr/local/sbin/chat-activate-incoming <id>` ([`activate-incoming.sh`](../infra/chat/activate-incoming.sh)). Lệnh đó chuyển bản upload vào `/opt/chat/staging` (chỉ root), đổi chủ sang root rồi mới kiểm (từ chối symlink và file đặc biệt), chuyển sang `/opt/chat/releases`, thay conf nginx bằng bản trong `/opt/chat/infra/nginx` (bản upload không đổi được nginx), rồi chạy `activate-release.sh`; cuối cùng workflow chạy `smoke.sh`.

- User `chat-deploy`: tạo bằng `bash /opt/chat/infra/setup-deploy-user.sh < chat-deploy.pub` (key ed25519, `authorized_keys` có `restrict`; sudoers chỉ cho một lệnh và thêm `/usr/local/bin`, nơi có `pm2`, vào `secure_path` của riêng user này).
- GitHub secret: `CHAT_DEPLOY_SSH_KEY` (private key, nạp qua stdin của `gh secret set`, không lưu trên máy dev), `CHAT_DEPLOY_KNOWN_HOSTS` (host key của server) và `CHAT_DEPLOY_PORT` (cổng SSH của server), cùng `CHAT_DEPLOY_HOST`, đều trong environment `production`.
- Script trong `/opt/chat/infra` (gồm cả bản cài cho sudo) chỉ đổi qua deploy bằng root bên dưới; khi sửa `infra/chat/` thì chạy deploy root một lần, rồi chạy lại `setup-deploy-user.sh < /dev/null` nếu `activate-incoming.sh` đổi.

Deploy bằng root từ gốc repo, key SSH qua thư mục tạm (cách nạp key ở skill `chat-ops-prod`):

```bash
SSH_TARGET=<user>@<SERVER_65_IP> SSH_OPTS="-i <key> -p <SSH_PORT> -o IdentitiesOnly=yes" bash infra/chat/deploy.sh
bash infra/chat/smoke.sh
```

`deploy.sh` build web và binary Linux trên máy dev, tải release lên, đồng bộ `infra/chat/`, rồi chạy [`activate-release.sh`](../infra/chat/activate-release.sh): backup DB, chạy migration bằng binary mới, cài conf nginx của release (`nginx -t` trước), đổi symlink, reload pm2 `chat-api`, chờ `/healthz`, rồi kiểm `/ws` trả 403 cho GET không có `Origin` và `POST /hook/` với hook không tồn tại trả JSON `hook_not_found`, cả trực tiếp ở `127.0.0.1:4600` lẫn qua nginx; lỗi ở bất kỳ bước nào sau khi đổi thì tự trở lại release trước. Migration chỉ thêm (expand), nên binary trước vẫn chạy được trên schema mới.

## Tài khoản vận hành (kiểm duyệt)

Hàng đợi kiểm duyệt (`ModerationService`) chỉ mở cho các user id ghi trong `CHAT_OPERATOR_USER_IDS` của `/opt/chat/.env`. Mặc định biến này không có, nên không ai là người vận hành. Cách cấp quyền:

1. Người được cấp đăng nhập chat một lần để có user. Lấy user id qua [`psql.sh`](../infra/chat/psql.sh): `SELECT id, username, name FROM users WHERE tenant_id = 'primary' AND username = '<username>';`.
2. Thêm vào `/opt/chat/.env` (nhiều id cách nhau bằng dấu phẩy, tối đa 100): `CHAT_OPERATOR_USER_IDS=<id>[,<id>…]`.
3. `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env` (process đọc lại `-env-file` khi khởi động); log khởi động ghi `operators=<số id>`. `GetSelf` của người đó trả `is_operator: true`.

Thu hồi: xoá id khỏi biến rồi reload. Mọi hành động kiểm duyệt (bỏ qua, xoá tin, cấm khỏi chat, khoá tài khoản chat, cảnh cáo, tắt webhook, gỡ khoá, xét duyệt và xác minh bot) và mọi lần luật tự động ra tay (`operator_id = 0`) ghi vào bảng `moderation_log` chỉ cho thêm (trigger chặn sửa và xoá); người vận hành xem ở Kiểm duyệt > Nhật ký và xuất CSV được.

### Ngưỡng chống spam

Đặt trong `/opt/chat/.env` (tuỳ chọn, giá trị mặc định ở [`.env.production.example`](../infra/chat/.env.production.example)); `0` tắt luật đó, đổi xong reload `chat-api` với `--update-env`:

- `ABUSE_STRANGER_CHATS_NEW` (20) và `ABUSE_STRANGER_CHATS` (50): số chat riêng mới với người chưa quen (chưa thêm mình vào danh bạ, không chung nhóm hay kênh) mỗi 24 giờ, cho tài khoản dưới `ABUSE_NEW_ACCOUNT_DAYS` (7) ngày tuổi và tài khoản lâu hơn.
- `ABUSE_REPORTERS` (3): đủ số người có báo cáo đang mở trong 30 ngày thì tài khoản tạm không nhắn được người chưa quen, tới khi kiểm duyệt đóng báo cáo.
- `ABUSE_SIGNUPS_PER_IP_HOUR` (30) và `ABUSE_SIGNUPS_PER_10MIN` (300): số tài khoản chat mới tạo ở lần đăng nhập đầu, theo IP mỗi giờ và toàn app mỗi 10 phút; vượt thì trang đăng nhập báo thử lại sau. Bộ đếm nằm trong bộ nhớ process, restart thì đếm lại.
- `CHAT_MAX_ONLINE_USERS` (1000, `0` là không giới hạn): số người khác nhau đang mở socket realtime trong process `chat-api`. Người đã online mở thêm thiết bị vẫn được; người mới vượt trần bị gateway đóng socket với mã "try again later", app giữ trạng thái "Đang kết nối…" và tự thử lại, các RPC (gửi tin, lịch sử) vẫn chạy. Con số lấy từ load test lượt 1 trên `.65` ([báo cáo](../plans/dattqh/reports/load-test-261017-1102-round1.md)).

Luật bot chạy 10 phút một lần trong `chat-api`: bot có ít nhất 20 người nhận trong 24 giờ mà từ 5% trong đó chặn bot, hoặc có từ 50 người dùng mới trong 24 giờ và gấp 10 lần trung bình tuần trước, bị hạ xuống tầng `restricted` và hiện ở đầu hàng đợi chờ xem xét. Ngưỡng này nằm trong code (`server/internal/chat/moderation_bots.go`).

## Cảnh báo vận hành (watchdog)

`chat-api` tự kiểm mỗi phút ([`server/internal/watch`](../server/internal/watch)). Một vấn đề phải còn ở hai lần kiểm liên tiếp mới báo, nên lúc deploy khởi động lại sẽ không báo nhầm. Cảnh báo vào nhóm **"Vận hành chat"**: lần đầu có vấn đề, watchdog tự tạo nhóm với operator đầu tiên trong `CHAT_OPERATOR_USER_IDS` làm trưởng nhóm, kèm nguồn cảnh báo "Giám sát" kiểu Alertmanager. Tin báo đổi tại chỗ từ firing sang resolved. Operator khác vào nhóm bằng link mời. Không có operator thì cảnh báo chỉ ghi vào log (`watch: alert firing`).

| Cảnh báo | Kiểm | Ngưỡng |
|---|---|---|
| `OutboxBacklog` | update chờ một consumer (realtime, push, bot) | quá 2 phút |
| `ErrorsInLog` | bản ghi mức ERROR của process | từ 10 trong 5 phút |
| `CertExpiring` | chứng chỉ TLS của host chat do nginx trên máy (`127.0.0.1:443`) phục vụ, không phải chứng chỉ Cloudflare ở địa chỉ công khai | dưới 14 ngày (dưới 3 ngày: critical) |
| `MemoryLow` | RAM khả dụng của máy | dưới 30% (dưới 15%: critical) |
| `DiskLow` | ổ chứa `/` và `MEDIA_ROOT` | dưới 15% trống (dưới 5%: critical) |
| `BackupStale` | bản mới nhất trong `/opt/chat/backups` | cũ hơn 26 giờ |

Watchdog không báo được khi chính `chat-api` sập. Cảnh báo cấp máy và "chat không trả lời" từ bên ngoài đặt trong OneDash (máy đã có `onedash-agent`, `vmagent`). Trạng thái cảnh báo nằm ở bảng `ops_alerts`, nguồn cảnh báo ở `ops_alert_hooks`.

### Tín hiệu phản hồi trong nhóm "Vận hành chat"

Cùng nhóm, cùng nguồn "Giám sát" (tin dạng native qua `hooks.PostNative`); không có operator thì bỏ qua, chỉ ghi log mức Info (`watch: no operators' group`). Không cần biến môi trường hay nginx mới.

- **Góp ý mới** (Cài đặt › Góp ý qua `FeedbackService.SendFeedback`, hoặc gửi bot Trợ lý) và **báo cáo vi phạm mới** (`UsersService.Report`) báo ngay khi ghi xong: loại, tên và @username người gửi, nguồn, trích tối đa 140 ký tự của góp ý (che email, số điện thoại, token), nút mở Kiểm duyệt › Góp ý hoặc Kiểm duyệt. Báo cáo chỉ có lý do và loại đối tượng, không có nội dung tin bị báo cáo hay ghi chú của người báo cáo. Lỗi khi đăng tin chỉ ghi log Warn, góp ý và báo cáo vẫn được lưu.
- **Bản tin hằng ngày** lúc **08:00 giờ Việt Nam** (Asia/Saigon) cho ngày hôm trước: người dùng mới, số người gửi tin, số tin (của người, có chữ hoặc file), góp ý mới và số đang mở, báo cáo mới, lỗi phía trình duyệt (tổng và 3 lỗi nhiều nhất). Bảng `ops_digests` giữ ngày đã đăng nên restart không đăng lại; process tắt qua 08:00 thì lúc chạy lại đăng đúng một bản, cho ngày gần nhất bị lỡ (không đăng bù từng ngày).
- **Lỗi phía trình duyệt** (`FeedbackService.ReportClientError`, nhận cả khi chưa đăng nhập): web gửi lỗi `error`, `unhandledrejection` và lỗi render (tối đa 5 mỗi lần tải trang, mỗi loại một lần). Server che dữ liệu cá nhân (bộ lọc `logging/redact`, rồi URL, số điện thoại, số), giới hạn theo user hoặc địa chỉ, chỉ giữ số đếm theo loại lỗi và ngày ở bảng `client_errors` (tối đa 500 loại mỗi ngày, xoá sau 90 ngày).

## Kiểm tra sau deploy

`infra/chat/smoke.sh`: `/` trả 200, `/healthz` báo `"db":"connected"`, `/auth/login` chuyển tới `auth.hoandat.com` với `client_id=chat-web`, `GetSelf` không có phiên trả 401, `/ws` không có phiên trả 401, `POST /hook/` với hook không tồn tại trả `hook_not_found`, `GET /bot/v1/me` không token trả 401 `unauthorized`; khi đã cấu hình media: `https://media-chat.hoandat.com/healthz` báo `"storage":"reachable"`, `/f/<token sai>` trả 404 có `nosniff` và không `Set-Cookie`, route của app trên host media trả 404 (chưa cấu hình thì bỏ qua và in thông báo). Sau đó đăng nhập thật trên trình duyệt và xem `pm2 describe chat-api` (số `restarts` không tăng).

## Webhook (incoming)

- Admin nhóm hoặc kênh tạo webhook qua `IntegrationsService` (giao thức ở [`server/README.md`](../server/README.md#webhook-incoming-package-internalhooks)). URL dạng `https://chat.hoandat.com/hook/<hook_id>/<secret>[/slack|/alertmanager|/grafana|/gitlab]`, chỉ hiện một lần; DB chỉ giữ SHA-256 của secret.
- Tra cứu khi có người báo "cảnh báo không về" (qua [`psql.sh`](../infra/chat/psql.sh), không bao giờ cần secret):
  - trạng thái: `SELECT id, chat_id, name, format, state, disabled_reason, last_used_at FROM incoming_hooks WHERE id = '<hook_id>';` (`auto_disabled` là người tạo đã mất quyền admin; admin khác nhận lại trong app);
  - request lỗi gần đây: `SELECT created_at, reason, detail, http_status FROM hook_dead_letters WHERE hook_id = '<hook_id>' ORDER BY id DESC LIMIT 20;`;
  - bộ đếm theo giờ: `SELECT * FROM hook_counters WHERE hook_id = '<hook_id>' ORDER BY hour DESC LIMIT 24;` và `hook_failures` (lý do lỗi, kể cả `rate_limited`);
  - lịch sử quản lý: `SELECT * FROM hook_audit WHERE hook_id = '<hook_id>' ORDER BY id;` (bảng chỉ thêm, trigger chặn sửa và xoá).
- URL lộ: admin xoay secret trong app với "thu hồi ngay", hoặc tắt webhook. Người vận hành tắt khẩn cấp: `UPDATE incoming_hooks SET state = 'disabled', disabled_reason = 'by_admin', disabled_at = now() WHERE id = '<hook_id>';` (có hiệu lực ở request kế tiếp).
- Dọn mỗi giờ: khoá idempotency quá 24 giờ; nhóm cảnh báo (`notify_groups`), bộ đếm và dead letter quá 30 ngày.

## Bot API (R5)

- Bot do người dùng tạo trong Developer Console (`BotAdminService`, giao thức ở [`server/README.md`](../server/README.md#bot-api-r5-package-internalbotapi)); bot gọi `https://chat.hoandat.com/bot/v1/…` với `Authorization: Bearer <bot_id>:<secret>`. DB chỉ giữ SHA-256 của secret; token không vào log nào (chỉ nằm trong header, log format của nginx chỉ ghi `$uri`).
- Tra cứu khi có người báo "bot không nhận tin" (qua [`psql.sh`](../infra/chat/psql.sh)):
  - bot: `SELECT b.user_id, u.username, b.owner_id, b.deleted_at, b.token_hash IS NOT NULL AS has_token, b.privacy, b.next_update_id FROM bots b JOIN users u ON u.id = b.user_id WHERE u.username = '<username>';`
  - update đang chờ: `SELECT kind, count(*), min(created_at) FROM bot_updates WHERE bot_id = <id> GROUP BY kind;` (bot không gọi `getUpdates` thì update hết hạn sau 24 giờ, callback 15 phút);
  - consumer: `SELECT last_id, updated_at FROM outbox_cursors WHERE consumer = 'bots';` so với `SELECT max(id) FROM outbox;` (lệch lâu là consumer kẹt, xem log `bot update consumer failed`);
  - consent: `SELECT source, created_at FROM bot_user_consent WHERE bot_id = <id> AND user_id = <user>;` (bot gửi riêng cho người chưa có dòng này nhận `403 no_consent`).
- Tầng `verified`/`internal` (rate limit cao hơn) chỉ đội vận hành đặt: `UPDATE bots SET verified = true WHERE user_id = <id>;`.
- Token lộ: chủ bot cấp lại token trong app. Người vận hành vô hiệu hoá khẩn cấp: `UPDATE bots SET token_hash = NULL WHERE user_id = <id>;` (có hiệu lực ở request kế tiếp).

## Bot chính thức (Trợ lý)

- Bot hệ thống chạy trong `chat-api` (không token, không có trong Developer Console của ai), giao thức ở [`server/README.md`](../server/README.md#bot-chính-thức-trợ-lý-package-internalassistant). Người vận hành đọc và trả lời góp ý ở Kiểm duyệt > Góp ý (cần `CHAT_OPERATOR_USER_IDS`).
- Tra cứu (qua [`psql.sh`](../infra/chat/psql.sh)):
  - bot: `SELECT b.user_id, u.username, u.name, b.verified, b.internal FROM bots b JOIN users u ON u.id = b.user_id WHERE b.is_system;`
  - góp ý đang chờ: `SELECT id, user_id, kind, created_at, left(text, 80) FROM feedback WHERE status = 'open' ORDER BY id DESC LIMIT 20;`
  - Trợ lý không trả lời: update chờ của nó `SELECT count(*) FROM bot_updates WHERE bot_id = <id> AND NOT acked;` và log `assistant` (`assistant could not read its updates`, `assistant skipped an update`).

## Media (R3)

Giao thức và giới hạn ở [`server/README.md`](../server/README.md#media-package-internalmedia). Chưa có `MEDIA_PUBLIC_URL` trong `/opt/chat/.env` thì media tắt: app chạy bình thường, `AppConfig.upload_size_max_bytes = 0` nên client ẩn nút đính kèm, RPC media trả `failed_precondition` `media_disabled`.

Media lưu trên chính server `.65` (Jev quyết 2026-10-15): upload đi qua API của app (từng part 8 MiB `PUT https://media-chat.hoandat.com/u/<token>`, tiếp tục được), không có URL S3 ký sẵn, không cần CORS; tải xuống do app stream có Range tại `MEDIA_PUBLIC_URL`.

Bật media (một lần):

1. DNS `media-chat.hoandat.com` proxied và chứng chỉ ở `/etc/letsencrypt/live/media-chat.hoandat.com/`, gia hạn bằng timer certbot như chứng chỉ của chat. Cloudflare để SSL "Full (strict)".
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

## Xuất và xoá dữ liệu (Phase 12, R9)

Người dùng tự xuất dữ liệu, bật tự xoá và xoá tài khoản chat ở Cài đặt › Tài khoản; danh mục dữ liệu và thời hạn: [`docs/privacy/data-inventory.md`](privacy/data-inventory.md). Migration `0019_account_deletion_export.sql` chạy cùng deploy (chỉ thêm cột, bảng, index, nới một CHECK). Không đổi nginx: link tải nằm dưới `/f/export/` của host media, đã đi qua location `/f/` (log che token). Không cần biến mới: bản xuất nằm ở `/opt/chat/media/exports` (app tự tạo, `chat:chat` 0750); đặt `DATA_EXPORT_DIR` chỉ khi muốn chỗ khác (S3 thì bắt buộc, không thì xuất dữ liệu tắt). Log khởi động có `"msg":"data exports","enabled":true`.

Vận hành:
- Bản xuất dựng từng cái một trong `chat-api`, giới hạn 4 GB file đính kèm, giữ chỗ trống `MEDIA_MIN_FREE_BYTES` trên đĩa (thiếu thì bản xuất `failed`, `error = 'disk_full'`); hết 30 ngày bị xoá trong job hằng giờ. Xem: `du -sh /opt/chat/media/exports`, `SELECT status, count(*), pg_size_pretty(sum(size_bytes)) FROM data_exports GROUP BY 1;`.
- Tài khoản đang chờ xoá: `SELECT id, deletion_reason, deletion_requested_at + interval '30 days' AS purge_at FROM users WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL;`. Job hằng giờ xoá hẳn tài khoản quá 30 ngày (log `deleted account erased`) và lên lịch xoá tài khoản bật tự xoá mà không dùng đủ số tháng (log `unused account scheduled for deletion`). Dữ liệu đã xoá còn trong bản sao lưu DB tối đa 14 ngày.

## Bảo mật mạng

- Xem trước link do server tải trang người dùng dán, nên site đích thấy IP gốc `<SERVER_65_IP>` (và biết server đứng sau Cloudflare). Việc vận hành cần làm: chặn cổng 443/80 của server với mọi nguồn trừ dải IP của Cloudflare (`https://www.cloudflare.com/ips/`), để biết IP gốc cũng không vượt được Cloudflare. Chưa làm trong repo này vì firewall của server dùng chung với các app khác. Webhook tới bot cũng đi ra từ IP này. Cả hai không gọi được chính `.65` (`OUTBOUND_DENY_CIDRS`, xem [Ràng buộc lâu dài](#ràng-buộc-lâu-dài)), nên luật này không bị vượt bằng một URL trỏ về chính server.

## Web Push và cài ứng dụng (PWA)

App cài được từ trình duyệt (Cài đặt › Cài ứng dụng) và báo tin mới khi đã đóng (Cài đặt › Thông báo › Thiết bị này). Giao thức ở [`server/README.md`](../server/README.md#web-push-package-internalpush-internalwebpush). Không đổi nginx (`sw.js`, `manifest.webmanifest` và icon đã được phục vụ; push đi ra từ server tới dịch vụ push của trình duyệt qua https, không có route mới). Migration `0018_web_push.sql` chạy cùng deploy (chỉ thêm bảng, trigger, cursor `push`).

Bật Web Push trên production (một lần, bằng root):

1. Sinh khoá VAPID vào `/opt/chat/.env`: `bash /opt/chat/infra/generate-vapid-key.sh /opt/chat/.env`. Script chỉ thêm `WEB_PUSH_VAPID_PRIVATE_KEY=` khi chưa có (không bao giờ thay khoá cũ: mọi trình duyệt đã đăng ký sẽ ngừng nhận push tới khi mở app lại), không in khoá riêng, in khoá công khai để đối chiếu. `setup-server.sh` cũng gọi script này. Tuỳ chọn `WEB_PUSH_SUBJECT=mailto:<email vận hành>` (mặc định là `CHAT_PUBLIC_URL`).
2. `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`; log khởi động có `"msg":"web push","enabled":true`.
3. Kiểm: đăng nhập trên Chrome, Cài đặt › Thông báo có thẻ "Thiết bị này"; bật "Thông báo khi đã đóng app", đóng tab, nhắn từ tài khoản khác: thông báo hiện, bấm vào mở đúng chat. Trên iPhone (iOS 16.4+) phải thêm vào Màn hình chính rồi mở từ đó mới bật được. Lỗi gửi xem trong log `chat-api` (`push rejected`, `push not delivered`, kèm host dịch vụ push).

Chưa có khoá thì Web Push tắt và app ẩn thẻ "Thiết bị này"; thông báo khi tab đang mở vẫn như trước. Tắt lại: xoá dòng khỏi `.env` rồi reload (subscription còn trong DB nhưng không được gửi; giữ nguyên dòng cũ nếu muốn bật lại mà không bắt người dùng đăng ký lại).

## Service worker: cập nhật

Hành vi ([`app-shell-worker.ts`](../apps/web/src/sw/app-shell-worker.ts)):

- Tải trang (`index.html`, mọi route của app) luôn lấy từ mạng trước; chỉ khi không tới được server mới mở `index.html` đã cache của build mà worker đang chạy. File trong `/assets/` (tên có hash) lấy từ cache trước.
- Worker của build mới cache xong file của nó thì thay ngay (`skipWaiting`, `clients.claim`), kể cả khi tab cũ còn mở và kể cả thay một worker đang `waiting` của bản trước (bản trước chờ tới khi đóng hết tab). Trình duyệt chỉ thấy `sw.js` mới khi kiểm tra cập nhật: mỗi lần tải trang online, và tab đang mở tự kiểm mỗi giờ và khi quay lại tab sau ít nhất 15 phút.
- nginx chỉ phục vụ `/assets/` của release hiện tại, nên worker **giữ cache của build cũ** khi còn tab chạy build đó: tab cũ vẫn tải được chunk lazy của nó. Worker hỏi từng tab đang mở đang chạy build nào (tên script entry `/assets/index-<hash>.js`) mỗi khi một tab mới mở, rồi xoá cache của build không còn tab nào chạy. Tab không trả lời (code trước bản này, tab bị đóng băng) thì giữ thêm tối đa 3 build gần nhất (`MAX_UNKNOWN_KEPT`, mỗi build khoảng 3,5 MB).
- Tab đang chạy build cũ hiện dòng "Đã có bản mới · Tải lại" (en: "A new version is available · Reload"); bấm thì tải lại trang và chạy build mới. App không tự tải lại (giữ bản nháp, hộp thoại đang mở). Tab mở sau deploy đã chạy build mới, không hiện dòng này.
- Rollback về release trước bản này: `sw.js` của release đó cài như một bản cập nhật nhưng **chờ** tới khi đóng hết tab (hành vi cũ), rồi xoá mọi cache khác. Trang vẫn lấy từ mạng trước nên người dùng tải lại là chạy đúng release; không cần kill switch.

Kiểm sau deploy: `sw.js` mang đúng script entry mà `index.html` đang nạp (in `1`), và trong trình duyệt DevTools → Application → Service workers không còn worker `waiting` sau một lần tải trang:

```bash
E=$(curl -s https://chat.hoandat.com/ | grep -o 'src="/assets/index-[^"]*\.js"' | cut -d'"' -f2)
echo "$E"; curl -s https://chat.hoandat.com/sw.js | grep -c "entry:.$E"
```

## Service worker: kill switch

Khi một worker lỗi đã tới trình duyệt (trang trắng, file cũ, không thoát được), thay `/sw.js` bằng bản tự gỡ [`infra/chat/sw-kill-switch.js`](../infra/chat/sw-kill-switch.js): worker này cài ngay (`skipWaiting`), xoá mọi cache `app-shell-*`, tự `unregister`, không có `fetch` handler nên request đi thẳng ra mạng. Tab đang mở không bị tải lại; từ lần tải sau chạy không có worker. Trình duyệt chỉ nhận khi kiểm tra cập nhật, tức lần tải trang online kế tiếp của từng người (`/sw.js` là `no-cache`).

1. Bật (root, không cần reload nginx, giữ qua các lần deploy):
   ```bash
   install -d -m 755 /opt/chat/sw-override
   install -m 644 /opt/chat/infra/sw-kill-switch.js /opt/chat/sw-override/sw.js
   curl -sI https://chat.hoandat.com/sw.js | grep -i -e '^HTTP' -e content-type -e cache-control   # 200, javascript, no-cache
   curl -s https://chat.hoandat.com/sw.js | head -3                                                   # dòng đầu "Kill switch for the web app's service worker"
   ```
   `location = /sw.js` lấy `/opt/chat/sw-override/sw.js` trước `current/web/sw.js`. Release mà conf nginx không có location này: khi đang chạy release như vậy, chép thẳng vào release đó (`install -m 644 /opt/chat/infra/sw-kill-switch.js /opt/chat/current/web/sw.js`; mất ở lần deploy sau).
2. Tắt (khi build đã sửa worker được deploy): `rm /opt/chat/sw-override/sw.js`. Lần tải trang sau, app đăng ký lại worker của release hiện tại. Trong lúc kill switch còn đó, mỗi lần tải trang app đăng ký lại `/sw.js` và kill switch lại tự gỡ: vô hại.

## Rollback

- Media: release trước R3 bỏ qua các bảng media; file trong `/opt/chat/media` giữ nguyên. Tắt media mà không rollback: xoá `MEDIA_PUBLIC_URL` khỏi `/opt/chat/.env` rồi reload (tin có media vẫn hiển thị thumb trong tin, nhưng không tải được bản đầy đủ).
- Code: `bash /opt/chat/infra/switch-release.sh <release-id>` (danh sách: `ls /opt/chat/releases`). Không đảo ngược dữ liệu. Về release không có `sw.js` (trước bản mở app khi offline) thì đặt kill switch ngay sau đó ([Service worker: kill switch](#service-worker-kill-switch)).
- Dữ liệu: dừng `chat-api`, `pg_restore --clean --if-exists` từ bản trong `/opt/chat/backups` với kết nối từ `pg-env.sh`, **tăng `server_epoch`** (`UPDATE server_meta SET server_epoch = server_epoch + 1;` qua [`psql.sh`](../infra/chat/psql.sh)), rồi chạy lại. Bản restore làm `pts`/`seq` lùi về lúc backup; epoch mới báo cho client rằng vị trí đồng bộ của nó không còn đúng, để client tự đồng bộ lại thay vì bỏ sót tin (ADR 0002). Process đang chạy đọc lại epoch mỗi 30 giây và yêu cầu mọi socket kết nối lại.

## Dữ liệu đồng bộ

- Nhật ký update theo người dùng (`user_updates`), theo chat lớn (`chat_updates`) và `outbox` chia partition theo ngày UTC. `chat-api` tạo trước partition cho 30 ngày tới khi khởi động và mỗi giờ (hàm SQL `chat_create_day_partitions`, transaction riêng, `lock_timeout` 5 giây) và log `Warn` `log partitions cover fewer days ahead than expected` khi còn dưới 7 ngày phía trước: thấy dòng này là phải xử lý trước khi ghi tin bị lỗi. Partition cũ hơn 30 ngày được tách bằng `DETACH PARTITION … CONCURRENTLY` rồi `DROP TABLE`, mỗi câu một transaction (không giữ khoá chặn ghi trên bảng cha). Nếu `chat-api` dừng quá 30 ngày thì phải chạy `SELECT chat_create_day_partitions(30);` (qua `psql.sh`) trước khi ghi tin.
- Rollback code về release **trước migration 0003** (trước R1) chỉ an toàn dưới 30 ngày: binary cũ không tạo partition, nên khi hết partition đã tạo trước thì mọi lần ghi `outbox` lỗi, kể cả trigger thu hồi phiên (đăng xuất, thu hồi phiên sẽ lỗi). Nếu phải ở lại bản đó lâu hơn, chạy `SELECT chat_create_day_partitions(30);` hằng ngày (cron) cho tới khi lên lại. Release từ 0003 trở đi dùng được trên schema 0004 (expand-only; binary R1 vẫn gọi `chat_ensure_day_partitions`, hàm này được giữ nguyên).
- Mỗi giờ: xoá `send_dedupe` cũ hơn 7 ngày, cache xem trước link cũ hơn 7 ngày, `jti` logout đã hết hạn.
- Số worker Snowflake (khoá tin nội bộ) được thuê trong bảng `snowflake_workers` (gia hạn mỗi 15 giây, hết hạn sau 60 giây), nên hai process không bao giờ cấp trùng khoá.
