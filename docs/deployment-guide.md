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

Release R5 lát A (Bot API lõi, migration `0013_bots`) đổi conf nginx (location `/bot/`, zone `chat_bot` 600 r/s mỗi IP, burst 1200, khai báo trong `chat.hoandat.com.conf`; vượt thì `429` cùng envelope JSON của Bot API qua `@bot_rate_limited`), `activate-release.sh` (thêm bước kiểm `/bot/v1/me` không token trả `401 unauthorized`) và `smoke.sh`, nên phải deploy bằng root một lần như R2: deploy tự động dùng conf nginx và script trong `/opt/chat/infra`, chưa có `/bot/`, nên `/bot/…` sẽ rơi vào web tĩnh. Không cần DNS mới, chứng chỉ mới, biến môi trường mới hay cài lại `chat-http.conf`; Bot API nằm trên host chat sẵn có (`https://chat.hoandat.com/bot/v1/…`) và chạy trong process `chat-api`, không thêm process pm2.

- Migration chỉ thêm: cột `users.is_bot`, `idp_sub` được phép `NULL` cho bot (kèm `CHECK (is_bot OR idp_sub IS NOT NULL)`), cột `user_sessions.auth_time`, bảng `bots`, `bot_user_consent`, `bot_callbacks`, `bot_updates`, cursor `bots` trong `outbox_cursors` đặt ở đầu log hiện tại. Binary R4 vẫn chạy trên schema mới (không đọc bot nào: bot không có phiên).
- Cấp lại token và xoá bot cần đăng nhập IdP trong 10 phút gần đây (ADR 0006): web gửi `/auth/login?reauth=1`, server gửi `prompt=login` và `max_age=600` rồi lưu `auth_time` của ID token vào phiên mới. IdP (`oidc-provider`) có `auth_time` khi request có `max_age`; sau deploy kiểm một lần bằng "Cấp lại token" trong Developer Console. Nếu IdP không trả `auth_time`, mọi lần cấp lại token đều trả `reauth_required`.
- Rollback code (`switch-release.sh`) về R4 không cần đụng dữ liệu; bot ngừng hoạt động (R4 không có `/bot/`).

Release R5 lát B1 (webhook tới bot, migration `0015_bot_webhooks`) không đổi nginx, script hay DNS: `PUT/GET/DELETE /bot/v1/webhook` nằm dưới `location ^~ /bot/` sẵn có, việc giao chạy trong process `chat-api`. Không có biến môi trường mới cho production (`BOT_WEBHOOK_ALLOW_LOCAL` chỉ dùng khi `CHAT_ENV=development`; đặt ở production thì server không khởi động). Deploy tự động như các lần sau.

- Migration chỉ thêm: cột webhook của `bots` (secret mã hoá bằng `SESSION_KEY`), cột giao của `bot_updates` (`queue_key`, `attempts`, `next_attempt_at`, `last_error`, `delivered_at`, `dead_at`), loại update `channel_post`, bảng `bot_delivery_counters`. Binary lát A vẫn chạy trên schema mới (không đọc cột mới; bot đặt webhook thì binary cũ không giao, update chờ tới 24 giờ).
- Server gọi ra URL webhook của bot (cổng 443/80/8443, chỉ địa chỉ công khai, chặn lúc kết nối). Đổi `SESSION_KEY` làm secret webhook không mở được: mỗi lần giao lỗi `secret_unreadable` tới khi chủ bot lưu lại webhook.
- Rollback code về lát A: binary cũ bỏ qua webhook, nên bot có webhook chỉ nhận update nếu chuyển sang long poll (binary cũ không trả `409` cho chúng); lên lại lát B1 thì webhook giao tiếp các update còn chờ.

Bản mở app khi offline (service worker `/sw.js` chỉ cache app shell: `index.html`, file trong `/assets/`, icon, manifest; không bao giờ `/rpc`, `/ws`, `/auth`, `/hook`, `/bot` hay host media) không đổi nginx, script hay biến môi trường, deploy như các lần sau. `location /` của `chat.hoandat.com.conf` đã trả `Cache-Control: no-cache` cho `/sw.js` và `index.html`, và CSP đã có `worker-src 'self'`; nếu sau này tách location riêng cho hai file này thì phải giữ `no-cache`, nếu không trình duyệt có thể giữ worker cũ lâu hơn. Mỗi build có một `sw.js` riêng (phiên bản là hash nội dung các file); cách worker mới thay worker cũ xem [Service worker: cập nhật](#service-worker-cập-nhật).

- Rollback code về một release cũng có `sw.js`: lần kiểm tra cập nhật tiếp theo (mỗi lần tải trang online) lấy `sw.js` của release đó, khác nội dung nên trình duyệt cài worker của bản đó; không cần làm gì thêm.
- Rollback về release **không có** `sw.js` (trước bản này): conf nginx của release đó trả `index.html` (200, `text/html`) cho `/sw.js`, nên lần kiểm tra cập nhật lỗi vì sai MIME và trình duyệt **giữ** worker đang có vô thời hạn. Worker đó vẫn lấy trang từ mạng trước, nhưng phục vụ manifest, icon, font từ cache và mở shell của build không còn trên server khi offline. Ngay sau `switch-release.sh`, đặt kill switch vào chính release đó: `install -m 644 /opt/chat/infra/sw-kill-switch.js /opt/chat/current/web/sw.js` (xem [Service worker: kill switch](#service-worker-kill-switch)).
- Từ bản hardening webhook (dưới), conf nginx có `location = /sw.js`: file thiếu thì `404`, không bao giờ `index.html`.

Bản hardening webhook và service worker (sau review 2026-10-15) **phải deploy bằng root một lần** vì đổi conf nginx (`location = /sw.js`, xem trên) và thêm file `infra/chat/sw-kill-switch.js`; deploy tự động chỉ dùng conf trong `/opt/chat/infra/nginx`. Không có migration, không cần DNS hay chứng chỉ mới.

- Biến môi trường mới `OUTBOUND_DENY_CIDRS` (tuỳ chọn, nhưng production phải đặt): IP hoặc dải CIDR mà webhook của bot và xem trước link không bao giờ gọi tới. Thêm vào `/opt/chat/.env` trước khi deploy: `OUTBOUND_DENY_CIDRS=103.72.98.65` (`activate-release.sh` reload pm2 với `--update-env`, nên process mới đọc ngay). Thiếu biến thì server vẫn chạy và vẫn chặn địa chỉ công khai trên network interface của máy; log khởi động `outbound requests refuse these ranges` liệt kê dải đang chặn, nên kiểm sau deploy rằng có `103.72.98.65/32`. Lý do: không có biến này, URL webhook trỏ thẳng vào `.65` (bản ghi DNS không proxy của app khác cùng máy) đi ra từ chính `.65`, qua được luật "chỉ IP Cloudflare" và các `allow <IP server>` của vhost khác.
- Developer Console: đặt hay đổi webhook (`SetBotWebhook`) cần đăng nhập IdP trong 10 phút như cấp lại token; quay về từ trang đăng nhập, Console mở hộp xác nhận với những gì đã nhập (giữ trong `sessionStorage` của tab, dùng một lần) và chỉ lưu khi bấm nút. `PUT /bot/v1/webhook` của Bot API không đổi (đã cần token). Đổi URL webhook ở Console cần secret mới.
- Webhook: câu trả lời 2xx chỉ đọc tối đa 64 KiB cho hành động; cả process tối đa 256 request đang chạy, chia đều giữa các bot; `Retry-After: 0` vẫn chờ 1 giây; bot rảnh không đọc DB theo đồng hồ. Số liệu 24 giờ của Console tính cả từ update còn lưu, nên có số từ trước khi bộ đếm ra đời.

Release R5 bot chính thức (Trợ lý, migration `0016_system_bot_feedback`) không đổi nginx, script, DNS hay biến môi trường; deploy tự động như các lần sau, không cần root.

- Migration chỉ thêm: cột `bots.is_system` (một bot hệ thống mỗi tenant, unique index), bảng `feedback`. Binary trước vẫn chạy trên schema mới: bot Trợ lý là một dòng `bots` hợp lệ (tự sở hữu, `owner_id` là chính nó), binary cũ không chạy logic của nó nên Trợ lý im lặng cho tới khi lên lại bản này.
- Khi khởi động, `chat-api` tạo (lần đầu) hoặc cập nhật bot Trợ lý: username `tro_ly_bot`, tên `<shortName> Trợ lý` lấy từ `brand.config.json` (bản sao `server/internal/brand/brand.json`, sinh bằng `pnpm brand:gen`), log `assistant bot ready`. Nếu một tài khoản đã giữ username đó, app vẫn chạy nhưng không có Trợ lý, log `Error` `assistant bot is off: another account holds its username`; đổi username tài khoản đó rồi reload.
- Mỗi người dùng có chat trống với Trợ lý ở lần mở app kế tiếp (`GetSelf`), ngay dưới "Cloud của tôi"; không có tin hàng loạt. Bot chỉ chào sau khi người dùng bấm "Bắt đầu".
- Góp ý gửi cho Trợ lý nằm ở Kiểm duyệt > Góp ý, chỉ tài khoản vận hành thấy: đặt `CHAT_OPERATOR_USER_IDS` như ở [Tài khoản vận hành](#tài-khoản-vận-hành-kiểm-duyệt). Chưa đặt thì góp ý vẫn được lưu, chỉ chưa ai đọc được.
- Rollback code về bản trước: chat với Trợ lý vẫn hiện (là chat với một bot), bấm "Bắt đầu" không có trả lời; góp ý đã lưu giữ nguyên.

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

Thu hồi: xoá id khỏi biến rồi reload. Mọi hành động kiểm duyệt (bỏ qua, xoá tin, cấm khỏi chat, khoá tài khoản chat, cảnh cáo, tắt webhook, gỡ khoá, xét duyệt và xác minh bot) và mọi lần luật tự động ra tay (`operator_id = 0`) ghi vào bảng `moderation_log` chỉ cho thêm (trigger chặn sửa và xoá); người vận hành xem ở Kiểm duyệt > Nhật ký và xuất CSV được.

### Ngưỡng chống spam

Đặt trong `/opt/chat/.env` (tuỳ chọn, giá trị mặc định ở [`.env.production.example`](../infra/chat/.env.production.example)); `0` tắt luật đó, đổi xong reload `chat-api` với `--update-env`:

- `ABUSE_STRANGER_CHATS_NEW` (20) và `ABUSE_STRANGER_CHATS` (50): số chat riêng mới với người chưa quen (chưa thêm mình vào danh bạ, không chung nhóm hay kênh) mỗi 24 giờ, cho tài khoản dưới `ABUSE_NEW_ACCOUNT_DAYS` (7) ngày tuổi và tài khoản lâu hơn.
- `ABUSE_REPORTERS` (3): đủ số người có báo cáo đang mở trong 30 ngày thì tài khoản tạm không nhắn được người chưa quen, tới khi kiểm duyệt đóng báo cáo.
- `ABUSE_SIGNUPS_PER_IP_HOUR` (30) và `ABUSE_SIGNUPS_PER_10MIN` (300): số tài khoản chat mới tạo ở lần đăng nhập đầu, theo IP mỗi giờ và theo tenant mỗi 10 phút; vượt thì trang đăng nhập báo thử lại sau. Bộ đếm nằm trong bộ nhớ process, restart thì đếm lại.

Luật bot chạy 10 phút một lần trong `chat-api`: bot có ít nhất 20 người nhận trong 24 giờ mà từ 5% trong đó chặn bot, hoặc có từ 50 người dùng mới trong 24 giờ và gấp 10 lần trung bình tuần trước, bị hạ xuống tầng `restricted` và hiện ở đầu hàng đợi chờ xem xét. Ngưỡng này nằm trong code (`server/internal/chat/moderation_bots.go`).

## Tenant khác (nghiệm thu `inetdev.io.vn`)

Mỗi tenant khác tenant chính chạy một process `chat-api-<id>` riêng trên cùng database, ở `https://chat.<domain>`. Process nào chỉ đọc outbox và dữ liệu của tenant mình. Tenant `inetdev.io.vn` chỉ dùng để nghiệm thu mô hình tenant; các app khác không cần làm theo.

1. Phía IdP (`hoandat-auth`): tenant đã có ở `auth.<domain>`. Chứng chỉ của tenant (`/etc/letsencrypt-tenants/live/<domain>/`) phải có `chat.<domain>`, và map `$tenant_cert` trong `00-tenants-http.conf` phải nhận nhãn `chat.`. Host `chat.<domain>` để DNS only hay Proxied qua Cloudflare đều được.
2. Trên server, với quyền root: `bash /opt/chat/infra/setup-tenant.sh <id> <domain> <cổng 4601–4699>`, ví dụ `setup-tenant.sh inetdev inetdev.io.vn 4601`. Script tạo `/opt/chat/tenants/<id>.env` một lần (`SESSION_KEY` mới; media và Web Push tắt).
3. Ghi secret `chat-web` của tenant (suy ra ở IdP từ `APP_CLIENT_SECRET_KEY`) vào `OIDC_CLIENT_SECRET` của file đó, không in ra màn hình.
4. Deploy release như thường lệ. `activate-release.sh` dựng `/etc/nginx/conf.d/chat-tenants.conf` bằng [`render-tenants-nginx.sh`](../infra/chat/render-tenants-nginx.sh) (block regex `chat.<tenant>` dựng từ conf chính), khởi động hoặc reload `chat-api-<id>`, rồi kiểm `/healthz` ở cổng của tenant. Tenant chưa có `OIDC_CLIENT_SECRET` thì chưa được khởi động; tenant lỗi chỉ in cảnh báo (`WARNING:` trong log deploy) và không rollback release của tenant chính. Thiếu `00-tenants-http.conf` thì tenant không được phục vụ và cũng chỉ có cảnh báo.

Tài khoản vận hành của tenant đặt bằng `CHAT_OPERATOR_USER_IDS` trong file của tenant (user id của chính tenant đó). Log nằm ở `/var/log/chat/api-<id>.*.log`.

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

- Bot hệ thống của tenant chạy trong `chat-api` (không token, không có trong Developer Console của ai), giao thức ở [`server/README.md`](../server/README.md#bot-chính-thức-trợ-lý-package-internalassistant). Người vận hành đọc và trả lời góp ý ở Kiểm duyệt > Góp ý (cần `CHAT_OPERATOR_USER_IDS`).
- Tra cứu (qua [`psql.sh`](../infra/chat/psql.sh)):
  - bot: `SELECT b.user_id, u.username, u.name, b.verified, b.internal FROM bots b JOIN users u ON u.id = b.user_id WHERE b.is_system;`
  - góp ý đang chờ: `SELECT id, user_id, kind, created_at, left(text, 80) FROM feedback WHERE status = 'open' ORDER BY id DESC LIMIT 20;`
  - Trợ lý không trả lời: update chờ của nó `SELECT count(*) FROM bot_updates WHERE bot_id = <id> AND NOT acked;` và log `assistant` (`assistant could not read its updates`, `assistant skipped an update`).

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

## Xuất và xoá dữ liệu (Phase 12, R9)

Người dùng tự xuất dữ liệu, bật tự xoá và xoá tài khoản chat ở Cài đặt › Tài khoản; danh mục dữ liệu và thời hạn: [`docs/privacy/data-inventory.md`](privacy/data-inventory.md). Migration `0019_account_deletion_export.sql` chạy cùng deploy (chỉ thêm cột, bảng, index, nới một CHECK). Không đổi nginx: link tải nằm dưới `/f/export/` của host media, đã đi qua location `/f/` (log che token). Không cần biến mới: bản xuất nằm ở `/opt/chat/media/exports` (app tự tạo, `chat:chat` 0750); đặt `DATA_EXPORT_DIR` chỉ khi muốn chỗ khác (S3 thì bắt buộc, không thì xuất dữ liệu tắt). Log khởi động có `"msg":"data exports","enabled":true`.

Vận hành:
- Bản xuất dựng từng cái một trong `chat-api`, giới hạn 4 GB file đính kèm, giữ chỗ trống `MEDIA_MIN_FREE_BYTES` trên đĩa (thiếu thì bản xuất `failed`, `error = 'disk_full'`); hết 30 ngày bị xoá trong job hằng giờ. Xem: `du -sh /opt/chat/media/exports`, `SELECT status, count(*), pg_size_pretty(sum(size_bytes)) FROM data_exports GROUP BY 1;`.
- Tài khoản đang chờ xoá: `SELECT id, deletion_reason, deletion_requested_at + interval '30 days' AS purge_at FROM users WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL;`. Job hằng giờ xoá hẳn tài khoản quá 30 ngày (log `deleted account erased`) và lên lịch xoá tài khoản bật tự xoá mà không dùng đủ số tháng (log `unused account scheduled for deletion`). Dữ liệu đã xoá còn trong bản sao lưu DB tối đa 14 ngày.

## Bảo mật mạng

- Xem trước link do server tải trang người dùng dán, nên site đích thấy IP gốc `103.72.98.65` (và biết server đứng sau Cloudflare). Việc vận hành cần làm: chặn cổng 443/80 của server với mọi nguồn trừ dải IP của Cloudflare (`https://www.cloudflare.com/ips/`), để biết IP gốc cũng không vượt được Cloudflare. Chưa làm trong repo này vì firewall của server dùng chung với các app khác. Webhook tới bot cũng đi ra từ IP này. Cả hai không gọi được chính `.65` (`OUTBOUND_DENY_CIDRS`, xem trên), nên luật này không bị vượt bằng một URL trỏ về chính server.

## Web Push và cài ứng dụng (PWA)

Từ bản PWA + Web Push (2026-10-16): app cài được từ trình duyệt (Cài đặt › Cài ứng dụng) và báo tin mới khi đã đóng (Cài đặt › Thông báo › Thiết bị này). Giao thức ở [`server/README.md`](../server/README.md#web-push-package-internalpush-internalwebpush). Không đổi nginx (`sw.js`, `manifest.webmanifest` và icon đã được phục vụ; push đi ra từ server tới dịch vụ push của trình duyệt qua https, không có route mới). Migration `0018_web_push.sql` chạy cùng deploy (chỉ thêm bảng, trigger, cursor `push`). Bản này có đổi `infra/chat/` (thêm `generate-vapid-key.sh`, `setup-server.sh` gọi nó), nên deploy bằng root một lần để đồng bộ `/opt/chat/infra`.

Bật Web Push trên production (một lần, bằng root):

1. Sinh khoá VAPID vào `/opt/chat/.env`: `bash /opt/chat/infra/generate-vapid-key.sh /opt/chat/.env`. Script chỉ thêm `WEB_PUSH_VAPID_PRIVATE_KEY=` khi chưa có (không bao giờ thay khoá cũ: mọi trình duyệt đã đăng ký sẽ ngừng nhận push tới khi mở app lại), không in khoá riêng, in khoá công khai để đối chiếu. `setup-server.sh` cũng gọi script này. Tuỳ chọn `WEB_PUSH_SUBJECT=mailto:<email vận hành>` (mặc định là `CHAT_PUBLIC_URL`).
2. `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`; log khởi động có `"msg":"web push","enabled":true`.
3. Kiểm: đăng nhập trên Chrome, Cài đặt › Thông báo có thẻ "Thiết bị này"; bật "Thông báo khi đã đóng app", đóng tab, nhắn từ tài khoản khác: thông báo hiện, bấm vào mở đúng chat. Trên iPhone (iOS 16.4+) phải thêm vào Màn hình chính rồi mở từ đó mới bật được. Lỗi gửi xem trong log `chat-api` (`push rejected`, `push not delivered`, kèm host dịch vụ push).

Chưa có khoá thì Web Push tắt và app ẩn thẻ "Thiết bị này"; thông báo khi tab đang mở vẫn như trước. Tắt lại: xoá dòng khỏi `.env` rồi reload (subscription còn trong DB nhưng không được gửi; giữ nguyên dòng cũ nếu muốn bật lại mà không bắt người dùng đăng ký lại).

## Service worker: cập nhật

Từ bản sửa cập nhật service worker (2026-10-15), deploy như thường: không đổi nginx, script hay biến môi trường. Hành vi ([`app-shell-worker.ts`](../apps/web/src/sw/app-shell-worker.ts)):

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
   `location = /sw.js` lấy `/opt/chat/sw-override/sw.js` trước `current/web/sw.js`. Release cũ hơn bản hardening webhook không có location này: khi đang chạy release như vậy, chép thẳng vào release đó (`install -m 644 /opt/chat/infra/sw-kill-switch.js /opt/chat/current/web/sw.js`; mất ở lần deploy sau).
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
