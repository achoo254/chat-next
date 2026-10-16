# Báo cáo bảo mật: review STRIDE + quét toàn repo (Phase 12)

**Dự án:** chat-next · **Phạm vi:** toàn repo; STRIDE sâu cho auth (callback OIDC, back-channel logout, redirect native, cô lập tenant), Bot API và webhook bot, incoming hook, media, RPC chat · **Chế độ:** audit rồi sửa các phát hiện đã kiểm · **Ngày:** 2026-10-16

Ba agent review (sonnet, chỉ đọc) chia theo mặt tấn công; các phát hiện được kiểm lại trong code trước khi sửa. Quyết định có đánh đổi do Jev chọn (xác suất ghi kèm).

## Tóm tắt

| Nhóm | Critical | High | Medium | Low | Info |
|---|---|---|---|---|---|
| Secret | 0 | 0 | 0 | 0 | 4 (giá trị giả trong test) |
| Dependency | 0 | 1 (Go stdlib) | 0 | 0 | 1 |
| Mẫu code | 0 | 0 | 0 | 0 | 4 (không phải lỗi) |
| STRIDE | 0 | 1 | 6 | 9 | 5 |

Không có Critical. Lỗi High duy nhất về logic (cấp lại token bot không gỡ webhook) đã sửa.

## Lớp quét nhanh

- `.env`: chỉ hai file mẫu được track (`deploy/dev/.env.example`, `infra/chat/.env.production.example`); `.gitignore` chặn các file khác.
- gitleaks (toàn lịch sử và thư mục): 4 phát hiện, cả 4 là giá trị giả trong file test (`server/internal/media/fixtures_test.go`, `server/internal/api/media_test.go`, `apps/web/test/app.test.tsx`, `apps/web/test/messaging-units.test.ts`). Ghi vào `.gitleaksignore`; quét lại sạch.
- govulncheck: code bị ảnh hưởng bởi 20 lỗ hổng của Go stdlib 1.26.4 (sửa ở 1.26.6). Đặt `toolchain go1.26.9` trong `server/go.mod`; quét lại còn 0 lỗ hổng ảnh hưởng tới code. Một lỗ hổng của `golang.org/x/crypto` chưa có bản sửa và code không gọi tới.
- `pnpm audit --prod`: không có lỗ hổng.
- Mẫu code: SQL chỉ ghép hằng số; `exec.CommandContext` của ffmpeg dùng mảng tham số; `dangerouslySetInnerHTML` chỉ cho SVG logo lúc build; `Math.random` chỉ cho jitter backoff.

## Phát hiện và xử lý

| # | Mức | Nhóm | Vị trí | Mô tả | Xử lý |
|---|---|---|---|---|---|
| 1 | High | E/S (bot) | `server/internal/rpc/bots_service.go` ResetBotToken | Cấp lại token không gỡ webhook: kẻ giữ token cũ đã đặt webhook vẫn nhận update và trả lời thay bot | Sửa: cấp lại token gỡ luôn webhook (Jev 0,95); hộp xác nhận Console nói rõ (mock + web) |
| 2 | Medium | I (bot) | `server/internal/chat/messages.go` repost | Bot bật chế độ riêng tư đọc được mọi tin nhóm qua copy/forward | Sửa: chỉ copy/forward được tin bot nhận được hoặc tin của nó (Jev 1,0); ghi vào OpenAPI |
| 3 | Medium | I (chat) | `server/internal/chat/messages.go` validateText, hook native | `mention_name` với user id bất kỳ làm lộ tên, username, bio, bỏ qua cài đặt riêng tư | Sửa: chặn khi gửi và sửa, người gửi phải có chung chat hoặc là danh bạ; integration chỉ mention thành viên chat (Jev 0,98 chọn chỉ chặn khi gửi sau khi biết chi phí lọc lúc hiển thị) |
| 4 | Medium | D (auth) | nginx `/auth/backchannel-logout` | Không giới hạn tần suất; chữ ký sai làm go-oidc tải lại JWKS của IdP mỗi lần (đã kiểm trong `go-oidc` v3.21.0 `RemoteKeySet.verify`) | Sửa: zone `chat_logout` 20 r/s burst 1000 mỗi IP |
| 5 | Medium | D (bot) | nginx `messages:send…` | nginx đệm tới 51 MiB xuống đĩa trước khi app xác thực token | Sửa: `proxy_request_buffering off`, tối đa 8 upload mỗi IP |
| 6 | Medium | D (hạ tầng) | nginx block 443 | IP thật của host qua Cloudflare đang nhờ `hoc-cloud.conf` (app khác) ở cấp http; log cho thấy IP thật đã tới (`123.25.x.x`) | Sửa: block chat tự khai `set_real_ip_from` loopback + dải Cloudflare và `real_ip_header` (Jev 1,0); cũng là phần chat của đề nghị từ phiên `hoandat-auth` |
| 7 | Medium | D (bot) | `server/internal/botapi/botapi.go` | Token sai từ IP đã bị khoá vẫn tốn một truy vấn DB | Không sửa: bất biến "token hợp lệ luôn qua" để bot chung NAT không khoá nhau; truy vấn theo khoá chính, nginx giới hạn 600 r/s mỗi IP |
| 8 | Medium | Chính sách | `server/internal/privacy/deletion.go` | Xoá tài khoản giữ nội dung tin trong chat của người khác (ẩn danh tác giả) | Đã ghi trong `docs/privacy/data-inventory.md`; đưa vào đánh giá Nghị định 13 |
| 9 | Low | I (auth) | nginx `/auth/` | Error log chép dòng request có `code`, `state` khi upstream lỗi | Sửa: `error_log /dev/null` cho `/auth/` |
| 10 | Low | D (auth) | `server/internal/auth/routes.go` | Trang lạ điều hướng tới callback với state giả xoá cookie đăng nhập đang dở | Sửa: chỉ xoá cookie khi state khớp (test cũ ghi hành vi cũ đã cập nhật) |
| 11 | Low | R (auth) | `logout_jti_seen` | Khoá chỉ theo `jti`, hai IdP tenant dùng chung bảng | Để lại: va chạm `jti` dạng UUID không thực tế |
| 12 | Low | E (auth) | `idp.go` | Không so `auth_time` với `max_age` ở callback | Để lại: các cổng sau (`requireRecentSignIn`) đã chặn |
| 13 | Low | I (media) | `server/internal/media/handler.go` authorize | URL media còn dùng được tới 1 giờ sau khi người xem rời chat, bị cấm hoặc ẩn tin | Để lại, ghi nhận: cửa sổ bằng thời hạn URL |
| 14 | Low | T (media) | `server/internal/media/service.go` | ETag lấy từ hash client khai | Để lại: chỉ ảnh hưởng file của chính người tải |
| 15 | Low | D (hook) | `server/internal/hooks/ingest.go` | Mỗi request có dạng hợp lệ tốn một truy vấn trước giới hạn trong Go | Để lại: nginx `chat_hook` 50 r/s mỗi IP; dò secret không khả thi |
| 16 | Low | I (hook) | `hook_dead_letters` | Lưu body thô tới 16 KiB | Để lại: chỉ admin chat đọc, có hạn xoá |
| 17 | Low | Bot | `AsBot`, `bot_updates`, chữ ký webhook | Giới hạn ghi của bot, nhân bản update theo số bot, secret gửi kèm HMAC | Để lại: theo thiết kế, có giới hạn tầng bot |

Info: `ExchangeNativeCode` (chưa làm) sẽ cần ngoại lệ cho kiểm `Origin` vì app native không gửi header này; HSTS chưa có `includeSubDomains` (cookie `__Host-` đã che); không kiểm `iss` theo RFC 9207 (mỗi process một IdP).

## Đã kiểm, không phải lỗi

Callback OIDC (state, nonce, PKCE S256, cookie niêm phong, so sánh thời gian hằng), redirect `return_to`, JWT back-channel logout (ES256, `typ`, `iss`, `aud`, `iat`, chống replay trong cùng transaction), cờ cookie `__Host-`, CSRF qua kiểm `Origin`, WebSocket, cô lập tenant trên mọi truy vấn phiên, token bot (băm SHA-256, so sánh thời gian hằng, chỉ trong header), SSRF của webhook bot và xem trước link (kiểm IP lúc dial, chống DNS rebinding, không theo redirect), token media và export (HMAC, gắn người xem, tenant, hạn), đường dẫn lưu trữ (UUID), zip slip của export, tìm kiếm (tham số hoá), CSP.

## Kiểm chứng

- Go: golangci-lint 0 issue; `go test -race -p 2 ./...` 33/33 gói qua (gói `chat` chạy lại sau khi sửa một test).
- Web: `pnpm lint` sạch (đã sửa 3 lỗi có sẵn ở `infra/chat/ecosystem.config.cjs`), `pnpm typecheck` qua, vitest 397/397, `pnpm perf` đạt mọi ngân sách, `pnpm e2e` 30/30.
- nginx: `render-tenants-nginx.sh` dựng block tenant có đủ các directive mới; `nginx -t` chạy trên server khi kích hoạt release.
