# Deploy chat (chat.hoandat.com)

Giai đoạn 1 của hạ tầng: app chat chạy chung server `103.72.98.65` với IdP, Localman và các app khác, theo quy ước của server đó (pm2, nginx một file mỗi host, không Docker Compose). Vận hành hằng ngày qua skill [`chat-ops-prod`](../.claude/skills/chat-ops-prod/SKILL.md). Khi tải chạm ngưỡng thì chuyển lên cụm riêng (plan, Phase 13 giai đoạn 2).

## Thành phần

| Thành phần | Vị trí |
|---|---|
| DNS (Cloudflare, zone `hoandat.com`) | `chat` → `103.72.98.65`, proxied. `*.chat` (bot, hook) thêm khi có release cần |
| TLS | Let's Encrypt `chat.hoandat.com` + `*.chat.hoandat.com`, DNS-01 Cloudflare với token Zone:DNS:Edit đã có trên server (`/etc/letsencrypt/cloudflare-localman.ini`), gia hạn bằng timer certbot kèm `systemctl reload nginx` ([`issue-cert.sh`](../infra/chat/issue-cert.sh)) |
| Release | `/opt/chat/releases/<id>/{server,web,nginx}`, id = giờ UTC + commit 12 ký tự (+`-dirty`), symlink `/opt/chat/current`; giữ 5 bản |
| Process | pm2 `chat-api` ([`ecosystem.config.cjs`](../infra/chat/ecosystem.config.cjs)), một instance, user hệ thống `chat`, binary Go tĩnh `server -role api -env-file /opt/chat/.env`, nghe `127.0.0.1:4600`, restart khi vượt 300 MB |
| nginx | `/etc/nginx/conf.d/chat-http.conf` (log format bỏ query, zone rate limit; cài một lần) và `/etc/nginx/conf.d/chat.hoandat.com.conf` (mỗi release mang bản của nó, [`nginx/`](../infra/chat/nginx/)). Web tĩnh từ `current/web`, `/rpc/` và `/auth/` tới API, `/healthz` công khai |
| Database | PostgreSQL 16.8 dùng chung của server (cổng 5432, chỉ localhost), database và role `chat` riêng, hai dòng `pg_hba` scram-sha-256 của chat đặt trước các dòng `ident` chung |
| Cấu hình | `/opt/chat/.env` (root:chat, 640), mẫu [`.env.production.example`](../infra/chat/.env.production.example); không bao giờ sync từ máy dev |
| Backup | [`backup-chat-db.sh`](../infra/chat/backup-chat-db.sh), cron 02:50 (`/etc/cron.d/chat-backup`), và trước mỗi lần kích hoạt release; giữ 14 bản trong `/opt/chat/backups` |
| Log | pm2 `/var/log/chat/api.{out,err}.log` (thư mục thuộc root vì daemon pm2 và cron backup chạy bằng root; pm2-logrotate của server xoay), nginx `/var/log/nginx/chat.hoandat.com.{access,error}.log` |

## Lần đầu (đã làm ngày 2026-10-14)

1. IdP: thêm `CHAT_WEB_URL` và `CHAT_WEB_CLIENT_SECRET` vào `/var/www/hoandat-auth/.env` (secret sinh trên server), deploy IdP theo `hoandat-auth/docs/deployment-guide.md`; cùng giá trị secret ghi vào `/opt/chat/.env` dưới tên `OIDC_CLIENT_SECRET`.
2. DNS `chat.hoandat.com` proxied.
3. Đồng bộ `infra/chat/` lên `/opt/chat/infra/`, chạy `bash /opt/chat/infra/issue-cert.sh` rồi `bash /opt/chat/infra/setup-server.sh` (user, thư mục, role/database Postgres, `pg_hba`, `SESSION_KEY`, `DATABASE_URL`, cron backup, conf nginx cấp http).
4. Deploy lần đầu như mục dưới.

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

`deploy.sh` build web và binary Linux trên máy dev, tải release lên, đồng bộ `infra/chat/`, rồi chạy [`activate-release.sh`](../infra/chat/activate-release.sh): backup DB, chạy migration bằng binary mới, cài conf nginx của release (`nginx -t` trước), đổi symlink, reload pm2 `chat-api`, chờ `/healthz`; lỗi ở bất kỳ bước nào sau khi đổi thì tự trở lại release trước. Migration chỉ thêm (expand), nên binary trước vẫn chạy được trên schema mới.

## Kiểm tra sau deploy

`infra/chat/smoke.sh`: `/` trả 200, `/healthz` báo `"db":"connected"`, `/auth/login` chuyển tới `auth.hoandat.com` với `client_id=chat-web`, `GetSelf` không có phiên trả 401. Sau đó đăng nhập thật trên trình duyệt và xem `pm2 describe chat-api` (số `restarts` không tăng).

## Rollback

- Code: `bash /opt/chat/infra/switch-release.sh <release-id>` (danh sách: `ls /opt/chat/releases`). Không đảo ngược dữ liệu.
- Dữ liệu: dừng `chat-api`, `pg_restore --clean --if-exists` từ bản trong `/opt/chat/backups` với kết nối từ `pg-env.sh`, rồi chạy lại.
