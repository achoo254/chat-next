---
name: chat-ops-prod
description: Tra cứu và vận hành app chat trên PRODUCTION (chat.hoandat.com, server dùng chung <SERVER_65_IP> cổng SSH 24700, pm2 chat-api, Postgres dùng chung db `chat`, release /opt/chat/current). Chỉ đường đọc docs/deployment-guide.md — credential SSH ở $ALL_IN_ONE_STAGING_DEV entry SSH_SERVER_STAGING, token ở $ACCESS_TOKENS_JSON; SSH/psql qua scripts/ của skill, deploy/rollback bằng infra/chat/. Kích hoạt khi user nhắc "prod", "production", "chat.hoandat.com", "server .65", "SSH prod", "psql prod", "log prod", "deploy", "rollback", "release", "pm2 chat-api", "backup chat". KHÔNG dùng cho dev local (pnpm dev, deploy/dev/docker-compose.yml).
---

# Chat Ops — Production

Skill này là **bản chỉ đường**. Nguồn chuẩn là `docs/deployment-guide.md` và các script trong `infra/chat/`
(chi tiết trong comment đầu mỗi script). Skill và tài liệu/script nói khác nhau thì **tài liệu và script đúng** — sửa skill.

## Cổng bắt buộc — chạy TRƯỚC mọi bước khác

Mỗi lần dùng skill này, làm đủ ba bước **trước** khi đọc tài liệu hay SSH:

1. **Nạp skill `typesafe:typesafe-ai` và để model Jev ra quyết định.** Key lấy từ `$ACCESS_TOKENS_JSON`, mục có
   `service == "api.typesafe.ai"`; đọc thẳng vào biến, gửi qua header từ file descriptor (`-H @<(printf …)`), không in,
   không đặt trong argv. Quyết định đầu tiên giao Jev là **chọn skill AgentKit** ở bước 2 (đồng thời là phép thử Jev còn
   dùng được). Sau đó mọi điểm quyết định (hướng điều tra, phương án, làm hay bỏ một bước) đều hỏi Jev với state là các
   **sự thật đã kiểm**; báo lại user câu hỏi và xác suất.
2. **Gọi skill AgentKit phù hợp** (`ak-*` trong danh mục đang cài):

   | Việc | Skill AgentKit |
   |---|---|
   | Điều tra sự cố, lỗi, log | `ak-debug` |
   | Sửa lỗi đã xác định | `ak-fix` |
   | Deploy, rollback, đổi hạ tầng | `ak-deploy` / `ak-devops` |
   | Truy vấn, migration, backup/restore Postgres | `ak-databases` |
   | Tìm tệp, script, cấu hình | `ak-scout` |
   | Bí mật lộ, rà bảo mật | `ak-security` |
   | Việc nhiều bước, không rõ skill | `ak-agentkit` |

3. **Không dùng được ⟹ báo ngay và DỪNG**: thiếu skill, thiếu key, Jev lỗi/timeout ⟹ báo user thứ hỏng, lỗi nguyên văn,
   bước đang làm; ngưng công việc cho yêu cầu đó, chờ user.

Jev quyết điểm **kỹ thuật**, không thay phép đo. Quyết định để lại cho user ⟹ gửi đúng các phương án cho Jev (`choice`,
state gồm rủi ro và đường lùi) rồi trình user lựa chọn của Jev kèm xác suất; AI không tự thực hiện theo.

## 0. Môi trường

| Dấu hiệu | Môi trường | Ai lo |
|---|---|---|
| `chat.hoandat.com`, `/opt/chat`, pm2 `chat-api`, db `chat` trên Postgres `127.0.0.1:5432` | **Chat prod** | skill này |
| `auth.hoandat.com`, pm2 `hoandat-auth`, `/var/www/hoandat-auth` | IdP dùng chung — repo `auth-next` (`~/inet-gitlab/hoandat-app/auth-next`) | đọc ở đây; sửa/deploy theo `auth-next/docs/deployment-guide.md` |
| `localman*`, `tunnel*`, Postgres db khác, Valkey `6379` của app khác, `vaultic`, `ai`, `tika`… | App khác trên cùng máy | không đụng |
| `pnpm dev`, `deploy/dev/docker-compose.yml` | Dev local | README |

Máy .65 là **máy dùng chung** (CentOS Stream 9, 4 nhân, 7,6 GB RAM, đo 14/10/2026 còn ~2,2 GB trống): thao tác sai ảnh
hưởng mọi app.

## 1. Luật cứng

1. **Deploy prod liên tục đã được user cho phép** (14/10/2026) cho chat: commit lên `main` qua đủ kiểm tra thì deploy.
   Thao tác ngoài deploy chuẩn (sửa tay `.env`, nginx, ghi dữ liệu, restore, đổi tường lửa) chỉ làm khi cần cho việc đang
   làm và phải báo user.
2. **Chỉ chạm thứ của chat**: pm2 `chat-api`, `/opt/chat`, db/role `chat`, conf nginx `chat*.conf`. Không
   `pm2 restart|reload|stop all`, không `pm2 kill`, không reload nginx khi chưa `nginx -t`, không sửa cấu hình Postgres/Valkey
   dùng chung.
3. **Không nối DB prod từ máy local.** Truy cập dữ liệu = `scripts/prod-psql.sh` (chạy `psql` ngay trên server).
4. **Không build trên server** (máy không có Go). Build ở máy dev bằng `infra/chat/deploy.sh`.
5. **Backup trước mọi migration/ghi dữ liệu**: `bash /opt/chat/infra/backup-chat-db.sh`, ghi tên bản backup vào báo cáo.
6. **Không in bí mật** (`DATABASE_URL`, `OIDC_CLIENT_SECRET`, `SESSION_KEY`, token Cloudflare…): đọc vào biến, truyền qua
   env/stdin/tệp, liệt kê `.env` chỉ bằng tên biến (`grep -o '^[A-Z_]*=' /opt/chat/.env`).
7. **Credential**: SSH .65 = `$ALL_IN_ONE_STAGING_DEV` entry `SSH_SERVER_STAGING` (không có trong `$ALL_IN_ONE_PROD`). Token
   Cloudflare sửa DNS zone `hoandat.com` nằm sẵn trên server (`/etc/letsencrypt/cloudflare-localman.ini`, chỉ dùng được từ IP
   .65); dùng nó ngay trên server, không kéo về máy dev.

## 2. Đường đọc — rẻ nhất trước

1. Từ ngoài: `curl -s -o /dev/null -w '%{http_code}\n' https://chat.hoandat.com/` và `…/healthz`.
2. `scripts/prod-ssh.sh` (cạnh tệp này): ghi key vào thư mục tạm 600, xoá khi thoát.

   ```bash
   S=.claude/skills/chat-ops-prod/scripts
   $S/prod-ssh.sh 'readlink /opt/chat/current; pm2 describe chat-api | grep -E "status|restarts"'
   $S/prod-ssh.sh 'curl -s 127.0.0.1:4600/healthz'
   $S/prod-ssh.sh 'pm2 logs chat-api --lines 100 --nostream'
   $S/prod-ssh.sh 'bash -s' < local-read-only-check.sh
   ```

3. `scripts/prod-psql.sh` — gửi SQL qua stdin, chạy `psql` trên server với `DATABASE_URL` đọc từ `/opt/chat/.env`.

## 3. Deploy và rollback

Theo `docs/deployment-guide.md` (§Các lần sau, §Rollback). Deploy từ gốc repo, key qua thư mục tạm, `umask 077` chỉ trong
subshell ghi key (để file build không thành 600):

```bash
K="$(mktemp -d)"; trap 'rm -rf "$K"' EXIT
(umask 077; jq -r '.servers[]|select(.name=="SSH_SERVER_STAGING")|.private_key' "$ALL_IN_ONE_STAGING_DEV" > "$K/key")
SSH_TARGET=root@<SERVER_65_IP> SSH_OPTS="-i $K/key -p 24700 -o IdentitiesOnly=yes" bash infra/chat/deploy.sh
```
