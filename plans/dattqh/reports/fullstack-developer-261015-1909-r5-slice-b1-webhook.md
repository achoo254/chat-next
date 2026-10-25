# R5 lát B1: webhook tới bot (Phase 8) và Console nhận update (Phase 15)

Ngày 2026-10-15. Chưa commit, không đụng production. Cây làm việc có thêm thay đổi của agent QA batch 3 (giữ nguyên); mọi gate dưới đây chạy trên cây gộp.

## Đã làm

- **`server/internal/safehttp`** (mới): client cho mọi request ra ngoài theo URL người dùng/bot chọn. Kiểm địa chỉ lúc dial trên địa chỉ đã resolve. Mọi địa chỉ của tên phải công khai; bị chặn: private, loopback, link-local (gồm `169.254.169.254`), CGNAT, multicast, unspecified, documentation/reserved, `fd00:ec2::254`, và các dạng IPv6 nhúng IPv4 (mapped, compatible, NAT64, 6to4, Teredo). Sau đó client nối thẳng tới địa chỉ đã kiểm, và `Control` kiểm lại địa chỉ thực nối. Ngoài ra: chỉ cổng 80/443/8443, chỉ https, không theo redirect, bỏ proxy môi trường, TLS luôn kiểm, timeout toàn request 10 giây. `ReadBody` giới hạn kích thước. Keep-alive chỉ tới địa chỉ đã kiểm, tối đa 30 giây sau lần dùng cuối. `linkpreview.PublicAddress` dùng chung `safehttp.PublicIP` (bỏ bản sao danh sách dải).
- **Migration `0015_bot_webhooks`** (expand-only):
  - `bots`: cột webhook; secret được sealbox bằng `SESSION_KEY`, purpose `bot-webhook-secret`, AAD là bot id.
  - `bot_updates`: `queue_key`, `attempts`, `next_attempt_at`, `last_error(_at)`, `delivered_at`, `dead_at`; thêm kind `channel_post`; thêm hai partial index (pending, dead).
  - Bảng mới `bot_delivery_counters` theo bot và giờ, giữ 2 ngày.
- **Dispatcher** (`botupdates/dispatch.go`), chạy trong `Run` của consumer, process `api`:
  - Một worker cho mỗi bot có webhook. Worker được đánh thức sau mỗi lượt consumer ghi update; DB là nguồn sự thật, kiểm lại mỗi 2 giây và quét lại danh sách bot mỗi 5 giây.
  - FIFO theo `queue_key`: `chat_id` cho tin, `-user_id` của người bấm cho callback. Mỗi hàng đợi chỉ một request đang chạy; các hàng đợi chạy song song tới `max_connections`.
  - Retry: 1 giây, nhân đôi, trần ngẫu nhiên 60–120 giây, hoặc theo `Retry-After` (kẹp 0–3600). Sau 10 lần thì dead-letter, update sau của hàng đợi đi tiếp. TTL theo `expires_at`.
  - Circuit breaker: sau 5 lần lỗi liên tiếp, bot đó chỉ còn 1 request song song tới khi thành công lại.
  - Request không giữ kết nối DB khi chờ webhook. Khi dừng: ngừng gửi mới, chờ tối đa 5 giây rồi huỷ; update bị huỷ vẫn ở trạng thái chờ.
- **Action trong body**: response 2xx là JSON có `method` thì chạy `sendMessage`/`answerCallback` qua `botapi.WebhookReply`, cùng kiểm tra và rate limit như gọi API.
  - `random_id = ReplyRandomID(bot_id, update_id)` (SHA-256, < 2^53, khác 0), nên giao lại không gửi trùng.
  - Action chạy trước khi ack; trả lời callback lần hai bị bỏ qua.
- **Bot API**: `PUT/GET/DELETE /bot/v1/webhook`. Long poll khi đang có webhook trả `409`; đặt webhook làm poll đang chờ kết thúc `409`. Lúc lưu, server resolve ngay để báo `url_blocked`/`url_unresolved`.
- **RPC `BotAdminService`** (proto chỉ thêm): `GetBotDelivery`, `SetBotWebhook` (secret rỗng giữ secret cũ), `DeleteBotWebhook`, `ListBotDeadLetters`, `RetryBotDeadLetters` (thêm đúng 1 lần giao), `DiscardBotDeadLetters`. Thêm `Bot.webhook`. Mọi RPC kiểm chủ bot; bot của người khác trả `not_found`.
- **Mục 6**:
  - Bot rời hoặc bị kick khỏi chat (`member_removed`): update đang chờ (kể cả dead-letter) của chat đó, cắt trước dòng outbox ấy, được ack mà không giao. Thêm lại bot thì nhận tin mới bình thường.
  - Bot là admin kênh nhận `channel_post`; bài bị sửa đến dưới dạng `message_edited`. Làm luôn vì rẻ.
- **`allowed_updates`**: lọc lúc cắt update, chỉ khi đang có webhook. `notRunning` (banner "Bot chưa chạy") không bật cho bot dùng webhook.
- **Web**: Console thêm 3 tab trong `bots/delivery.tsx`, thuộc chunk console nạp lười:
  - **Nhận update**: chọn webhook hoặc long poll; URL; secret có nút Tạo mới và hiện/ẩn, không bao giờ đọc lại secret từ server; loại update dạng chip; số kết nối song song; bỏ update đang chờ. Cột trạng thái tự làm mới mỗi 5 giây.
  - **Update lỗi**: Thử lại / Bỏ từng dòng hoặc tất cả.
  - **Số liệu**: 24 giờ cộng tầng rate limit.
  - Danh sách bot ghi Webhook/Long poll. Tab Token của bot có webhook dẫn sang tab Nhận update.
- **Mock được sửa trước** (`console.html` #webhook, #dead-letter, #stats, #token):
  - Chỉ còn các loại update đã giao được.
  - Mô tả hành vi secret.
  - Số liệu là bộ đếm giao update; bỏ bảng bulk và nhãn "Minh hoạ".
  - Sửa host `bot.chat` thành `chat.hoandat.com/bot/v1`.
  - Cột "Chat" đổi thành "Cuộc chat", vì brand check cấm chuỗi "Chat".
- **Docs**:
  - `server/README.md`: biến môi trường, RPC, method, webhook, safehttp, giả định một instance.
  - `spec/bot-api/openapi.yaml`: `/webhook`, `webhooks.update` (headers, retry, HMAC), `WebhookAnswer`, `channel_post`; `format.md`.
  - `docs/bot-api/README.md` (mới, tiếng Việt): bắt đầu nhanh và kiểm HMAC bằng Node/Python/Go. Cả ba snippet đã chạy thử, kèm test vector.
  - `docs/README.md`.
  - `docs/deployment-guide.md`: ghi chú lát B1, rollback, IP gốc.
  - Checkbox của phase-08 và phase-15.

## Hợp đồng webhook

Mỗi lần giao là một `POST` JSON (một update), kèm các header:

- `X-Bot-Api-Secret-Token: <secret>`
- `X-Bot-Timestamp: <giây Unix>`
- `X-Bot-Signature: v1=<hex HMAC-SHA256(secret, ts + "." + body)>`

Test vector: `my_secret` / `1760500000` / `{"update_id":1}` cho ra `v1=12ce7a96…e8e1`. Response 2xx trong 10 giây là thành công. Mã lỗi lưu lại: `http_<status>`, `timeout`, `tls`, `connect`, `dns`, `blocked_address`, `invalid_url`, `secret_unreadable`. Giao ít nhất một lần, nên bot cần bỏ trùng theo `update_id`.

## Bảo mật

- Chặn SSRF ở lúc dial, không chỉ lúc lưu. Đã có test cho: IP private trực tiếp, redirect (không theo, đích không nhận request), DNS rebinding (resolver trả địa chỉ công khai lúc lưu rồi private lúc dial), tên có cả địa chỉ công khai lẫn private, IPv4-mapped, cổng lạ, response quá lớn, timeout, TLS tự ký.
- `BOT_WEBHOOK_ALLOW_LOCAL` chỉ hợp lệ khi `CHAT_ENV=development`; đặt ở production thì server không khởi động. Cờ này mở http, loopback và mọi cổng (e2e-stack bật sẵn); vẫn không mở dải private khác.
- Secret được lưu đã mã hoá, không trả về qua API hay Console. HMAC kèm timestamp chống giả mạo và replay; docs khuyên bỏ request lệch quá 5 phút.

## Bằng chứng kiểm thử

- Go:
  - `gofmt -l` rỗng; `go vet ./...` sạch; `golangci-lint run ./...` báo `0 issues.`
  - Full `go test -race -count=1 -p 2 ./...`: 27 gói `ok`, không gói nào lỗi.
  - Test mới:
    - `safehttp`: 8 test.
    - `botupdates`, chạy `-count=4` không flaky: thứ tự và chữ ký, song song giữa chat, dead-letter rồi chat đi tiếp, retry/discard, backoff 1 s rồi 2 s, `Retry-After` 120, bot treo 10 s trên 12 chat không làm chậm bot khác (lần giao chậm nhất < 1 s), webhook và long poll loại trừ nhau, kiểm cài đặt, `allowed_updates`, bot bị kick, `channel_post`, action gửi đúng một lần qua sự cố và restart, `answerCallback` trong body, unit test retry/HMAC.
    - `botapi`: các method `/webhook`.
    - `api`: luồng Console qua RPC tới receiver rồi reply, kiểm quyền chủ.
    - `config`: biến mới.
  - Migration 0015 qua down/up (`TestLatestMigrationRollsBack`).
- `pnpm lint`: không lỗi, brand check sạch. `pnpm typecheck`: 6/6 Done.
- vitest `--maxWorkers=2`:

  | Gói | File | Test |
  |---|---|---|
  | web | 32 | 324 |
  | core | 23 | 765 |
  | platform-web | 5 | 17 |
  | brand | 1 | 11 |

  Mới: `bot-delivery.test.tsx` (7 test).
- `pnpm perf`: mọi budget đạt.
  - Startup JS 146,3 KB / 150 (trước 141,0). Phần lớn tăng do batch QA (service worker); helper webhook đã được chuyển khỏi `api.ts` vào chunk console.
  - CSS 16,7 KB / 20; mở chat p50 18 ms, p99 41 ms.
- `pnpm e2e`: 20/20 pass trong 77 giây. Có kịch bản mới trong `bots.e2e.ts`:
  1. Bot đặt webhook `http://127.0.0.1:<port>`; receiver kiểm secret, HMAC và timestamp.
  2. Long poll trả 409.
  3. An nhắn, rồi thấy "Webhook nhận: …" do action trong body gửi.
  4. Console hiện "Đang hoạt động", tab Số liệu có số liệu.
  5. Chuyển về Long poll trong Console, rồi `GET /updates` chạy lại.
- Kiểm hình bằng Playwright trên e2e stack, ở 1333x780 và 390x844, cho 3 tab: không phần tử nào tràn ngang hay cuộn ngang. Ảnh trong `plans/dattqh/reports/fullstack-developer-261015-1909-r5-slice-b1-shots/`. Theo ảnh, nút chọn chế độ được làm gọn (`justify-self: start`). Đã dừng stack.
- `buf lint` và `buf breaking` sạch; `pnpm proto:gen` đã chạy. Có tái sinh cả `users_pb`/`users.pb.go` từ thay đổi proto của agent kia (deterministic).
- `redocly lint`: valid, 0 cảnh báo.
- gitleaks: "no leaks found" trên từng đường dẫn mới hoặc đã sửa và trên `git diff`.

## Deploy

- Không đổi nginx (`/bot/` đã có), không có script mới, không DNS hay chứng chỉ mới, không biến môi trường production mới, không process pm2 mới. Deploy tự động bình thường, không cần root. Migration 0015 tự chạy.
- Server gọi ra internet từ IP gốc `<SERVER_65_IP>` (như link preview). Firewall cần cho phép outbound 80/443/8443.
- Đổi `SESSION_KEY` thì secret webhook không đọc được nữa (lỗi `secret_unreadable`) tới khi chủ bot lưu lại webhook.
- Giả định một process `chat-api`: hai instance sẽ cùng giao một update và phá thứ tự trong chat. Đã ghi trong README.

## Còn mở

1. Hai instance và chuyển release: nếu một lần reload pm2 để process cũ và mới chạy chồng nhau, một update có thể bị giao hai lần trong khoảnh khắc đó. Ngữ nghĩa vẫn là ít nhất một lần; action trong body đã được dedupe.
2. Bot gặp `410` liên tục chưa tự bị gỡ webhook (Telegram gỡ sau 23 giờ). Không nằm trong yêu cầu.
3. Avatar bot, SDK, test validate response theo OpenAPI: vẫn để lát sau.

Status: DONE
Summary: Đã giao webhook tới bot (safehttp, dispatcher FIFO theo chat, retry/Retry-After, dead-letter, circuit breaker, HMAC, action trong body chạy đúng một lần), RPC và Console (Nhận update, Update lỗi, Số liệu), bỏ update khi bot bị kick, `channel_post`, cùng spec và docs. Mọi gate (Go race full, lint, typecheck, vitest, perf, e2e 20/20, proto, redocly, gitleaks) đều pass trên cây gộp.
Concerns: giả định một process `chat-api` cho dispatcher; startup JS 146,3/150 KB, còn ít dư.
