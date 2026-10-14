# Research: Notification pipeline siêu nhanh (Bot + incoming webhook)

Ngày: 2026-10-13 (Asia/Saigon) · Phạm vi: greenfield, web-first + Capacitor + Tauri · Bối cảnh: alert hệ thống của iNET (monitoring, CI/CD, billing, OTP-like)
Không lặp lại: Bot API wire-compat, `getUpdates`/`setWebhook`, SSRF (xem `researcher-261013-1120-telegram-bot-platform.md`); pts/outbox/gateway/push cơ bản (xem `researcher-261013-1120-backend-sync-search.md`).

## 0. Kết luận trước

1. **Ingest:** một lõi `NotificationIngest` duy nhất, nhiều "mặt" payload. Thứ hạng: (1) native JSON, (2) Telegram `sendMessage` (gần như miễn phí vì đã có Bot API), (3) **Slack-compatible incoming webhook** (độ phủ công cụ cao nhất), (4) Discord-compatible (rẻ, chủ yếu cho Zabbix), (5) adapter riêng cho Alertmanager v4 (có `groupKey` để gộp alert). Không làm Teams/Google Chat format, không làm script tùy biến kiểu Rocket.Chat ở v1.
2. **Fast path đồng bộ, không qua broker:** HTTP ingest → **một transaction Postgres** (message + seq + pts + outbox + idempotency) → trả `message_id` → publish ngay sau commit tới Redis pub/sub (realtime) và dispatcher push trong process. Outbox chỉ là lưới an toàn (sweep 200 ms), không nằm trên đường nóng.
3. **Queue:** v1 dùng **Postgres outbox + `FOR UPDATE SKIP LOCKED` + eager dispatch**, không thêm hạ tầng. Khi scale, outbox relay đổ sang **NATS JetStream** (khớp kế hoạch NATS của gateway). Không dùng Kafka/Redpanda cho delivery tới bot/push vì head-of-line blocking theo partition; chỉ dùng cho CDC/analytics. Không dùng `LISTEN/NOTIFY` cho từng message.
4. **Rate limit theo tier**, mặc định bằng Telegram, nâng cho bot đã xác minh và bot alert nội bộ; tách **4 lane ưu tiên** với worker pool và quota FCM riêng.
5. **Alert UX:** `idempotency_key` (retry chính xác) tách khỏi `group_key` (gộp alert lặp lại, sửa tại chỗ, chỉ push khi đổi trạng thái).
6. **SLO đề xuất:** POST → 200 (server-side) p50 ≤ 15 ms, p99 ≤ 50 ms; tới client online p50 ≤ 100 ms, p99 ≤ 300 ms; tới FCM/APNs nhận p50 ≤ 200 ms, p99 ≤ 1 s. Thời gian từ provider tới máy không kiểm soát được, chỉ đo bằng canary.

## 1. Source manifest (độ tin cậy)

| Nguồn | Loại | Tin cậy | Dùng cho |
|---|---|---|---|
| docs.slack.dev (incoming webhooks, rate limits) | Docs chính thức | Cao | Payload, `ok`, 1 msg/s |
| docs.discord.com (webhook, rate-limits) | Docs chính thức | Cao | `wait`, `/slack`, `/github`, bucket theo webhook |
| docs.mattermost.com (incoming webhooks) | Docs chính thức | Cao | Slack-compat, `silent`, split 16.383 ký tự |
| developers.google.com Chat webhooks | Docs chính thức | Cao | `threadKey`, 1 req/s/space |
| Alertmanager `docs/configuration.md` (main) | Source/docs | Cao | Receiver, `api_url`, `groupKey`, mặc định group |
| grafana/alerting `receivers/*` | **Source code** | Cao | Telegram URL hardcode, Slack `ok` check |
| GitLab `app/models/concerns/integrations/base/*.rb` | **Source code** | Cao | Discord regex chặn host, Telegram `hostname` |
| louislam/uptime-kuma 2.5.6 `server/notification-providers` | **Source code** | Cao | Telegram server URL, Slack/Discord URL tự do |
| zabbix/zabbix `templates/media/*` | **Source code** | Cao | Discord `?wait=True`, Slack Web API |
| jenkinsci/slack-plugin `StandardSlackService.java` | **Source code** | Cao | `baseUrl + token` |
| standard-webhooks spec (TSC: Zapier, Twilio, Svix, Kong…) | Spec cộng đồng | Cao | Header ký, rotation |
| firebase.google.com throttling-and-quotas | Docs chính thức | Cao | 600k/phút, 240/phút/máy, collapsible 20 burst |
| Recall.ai blog (2025-07, cập nhật 2026-05); DBOS blog (2026-07) | Case study production | Trung bình–cao | Khóa toàn cục của `NOTIFY` |
| Confluent "Kafka fastest" (2020-08) | Benchmark của vendor | Trung bình | Kafka p99 5 ms |
| Svix retries docs; Twilio status callback docs | Docs vendor | Cao | Lịch retry, mô hình status |

## 2. Incoming webhook: chọn format nào

### 2.1 Đặc điểm các nền tảng (đã kiểm chứng)

| Nền tảng | URL / auth | Payload chính | Response | Giới hạn | Điểm đáng học |
|---|---|---|---|---|---|
| Slack | `hooks.slack.com/services/T/B/X`, 1 URL = 1 kênh | `text` (bắt buộc), `blocks`, `attachments` (≤100), `thread_ts` | `200 ok` text/plain; lỗi `invalid_payload`, `channel_not_found`… | 1 msg/s, cho burst ngắn; 429 + `Retry-After` | Không cho override kênh → an toàn; Slack tự quét và thu hồi URL bị lộ |
| Discord | `/webhooks/{id}/{token}` | `content` ≤2000, `embeds` ≤10, `username`, `avatar_url`, `flags` (`SUPPRESS_NOTIFICATIONS`) | `wait=false` → 204; `wait=true` → message object | Bucket per-route theo webhook; header `X-RateLimit-*`; 10.000 request lỗi/10 phút → chặn IP | Có sẵn endpoint `/slack` và `/github` tương thích (mặc định `wait=true`) |
| Mattermost | URL secret | Slack-compat + `channel`, `props`, `priority`, `silent` | `200 ok` | Không nêu | Bằng chứng Slack-compat khả thi; tin dài tự tách thành nhiều post |
| Google Chat | `?key=&token=` | `text`, `cardsV2`, `thread.threadKey` + `messageReplyOption` | Chỉ trả `name` | 1 req/s cho cả space | `threadKey` do client tự đặt → gom alert theo thread |
| Teams | Workflows (Power Automate); O365 connector đã ngừng hẳn khoảng 2026-05 | Adaptive Card / MessageCard | — | — | Không đáng mô phỏng |
| Rocket.Chat | Integration + script JS `process_incoming_request` chạy trong VM | Tùy script | JSON | — | Linh hoạt nhưng là bề mặt tấn công; để sau |

### 2.2 Công cụ nào nói được format nào (đọc source, trừ chỗ ghi khác)

| Công cụ | Slack webhook (URL tùy ý) | Discord webhook (URL tùy ý) | Telegram (đổi base URL) | Generic webhook |
|---|---|---|---|---|
| Prometheus Alertmanager | Có (`api_url`) | Có (`webhook_url`) | **Có** (`api_url`, `telegram_api_url`) | JSON v4 có `groupKey`; `payload` template (tự chịu rủi ro) |
| Grafana Alerting | **Có**; còn hỗ trợ `endpointUrl` kiểu `chat.postMessage` | Có | **Không**: `APIURL = "https://api.telegram.org/bot%s/%s"` hardcode | Có (JSON riêng của Grafana) |
| GitLab | Qua tích hợp **Mattermost** (Slack format, URL tùy ý); "Slack notifications" đã deprecated | **Không**: regex `\Ahttps://(canary\.\|ptb\.)?discord\.com` | **Có** (`hostname`, từ 17.1) | Project webhook + `X-Gitlab-Token` |
| Uptime Kuma 2.5.6 | Có | Có | **Có** (`telegramServerUrl`) | Có, body tùy biến |
| Zabbix | Media type Slack dùng Web API `slack.com` (sửa được JS) | **Có**; tự thêm `/api/v10/` và `?wait=True` | Hardcode trong JS, sửa 1 dòng | Media type webhook JS |
| Jenkins | Có, Slack plugin "Override URL" gửi tới `baseUrl + token` | Có plugin (chưa đọc source) | Plugin Telegram không thấy base URL, đang có advisory bảo mật chưa vá | `curl` trong pipeline |
| Sentry | **Không**: Slack/Discord/Teams là OAuth app/bot | Không | Không | Internal integration ký `Sentry-Hook-Signature` (HMAC-SHA256) → cần adapter riêng |

### 2.3 Xếp hạng và khuyến nghị

| Hạng | Format | Phủ được | Chi phí | Quyết định |
|---|---|---|---|---|
| 1 | Native JSON `POST /hooks/{id}/{secret}` | Mọi thứ có `curl`/generic webhook | Thấp | **v1**. Là contract chuẩn, có đủ `group_key`, `priority`, `notify` |
| 2 | Telegram `POST /bot<token>/sendMessage` | Alertmanager, GitLab, Uptime Kuma, mọi script Telegram | ~0 (dùng chung Bot API) | **v1** |
| 3 | Slack-compatible (`/hooks/{id}/{secret}/slack`) | Alertmanager, Grafana, GitLab (qua Mattermost), Uptime Kuma, Jenkins | Thấp–TB (map `text` mrkdwn, `attachments`, `blocks` tối thiểu) | **v1**. Bắt buộc trả đúng `ok` text/plain vì Grafana so sánh byte |
| 4 | Discord-compatible (`/api/webhooks/{id}/{token}` và `/api/v10/...`) | Zabbix, Alertmanager, Grafana, Uptime Kuma | Thấp | **v1.1**. Parse `wait` không phân biệt hoa/thường (Zabbix gửi `True`) |
| 5 | Adapter nguồn: Alertmanager v4, GitLab events, Sentry | Gộp alert theo `groupKey`, render đẹp | TB | Alertmanager **v1** (lấy `groupKey`/`status` để coalesce); GitLab, Sentry **v2** |
| — | Teams/Google Chat format, script JS tùy biến | Thấp | Cao, rủi ro sandbox | Không làm. Nếu cần, dùng template khai báo (JSONata hoặc Go template) ở v2 |

Thiết kế chung: mọi "mặt" đều chỉ là **translator → `IngestRequest` nội bộ**, dùng chung auth, rate limit, idempotency và render. Cách này DRY, và thêm format mới chỉ tốn một file mapping. Endpoint native nhận thêm `?wait=false` để trả 202 sớm cho caller không cần `message_id`, nhưng mặc định vẫn là đồng bộ (đã persist), vì commit chỉ mất vài ms.

## 3. Outgoing webhook tới bot: throughput và cô lập

Bot report đã chốt semantics (FIFO theo `queue_id`, `max_connections` 1–100, mặc định 40). Phần này chỉ bàn chuyện tốc độ.

- **Scheduler không chặn đầu hàng:** mỗi bot có hàng đợi ảo riêng và semaphore riêng (= `max_connections`); mỗi chat tối đa 1 request in-flight. Dispatcher chung chỉ lấy việc từ bot còn slot trống, nên bot chậm chỉ tự làm đầy slot của nó (bulkhead).
- **Tái dùng kết nối:** Go `http.Transport` mặc định `DefaultMaxIdleConnsPerHost = 2`, trong khi Telegram cho phép 40 request song song mỗi bot. Để mặc định thì phần lớn request phải bắt tay TCP+TLS lại. Đặt `MaxIdleConnsPerHost = MaxConnsPerHost = max_connections`, `IdleConnTimeout` 90 s, bật HTTP/2 qua ALPN (`ForceAttemptHTTP2`, mặc định true ở DefaultTransport). Mỗi bot một `Transport` (hoặc pool theo host) để không tranh idle pool.
- **Timeout tầng:** dial 3 s, TLS 3 s, response header 10 s, tổng 15 s (Standard Webhooks khuyên 15–30 s). Bot nội bộ có thể đặt ngắn hơn.
- **Adaptive concurrency + circuit breaker theo endpoint:** theo dõi EWMA latency; latency tăng thì giảm in-flight kiểu AIMD. Circuit mở khi ≥5 lỗi liên tiếp hoặc >50% lỗi trên 20 request, half-open thử 1 request sau 5–30 s (backoff). Khi mở, update vẫn nằm trong hàng đợi bền (TTL như Telegram) và `getWebhookInfo` hiện `last_error_*`, `pending_update_count`. Thư viện: `failsafe-go` (MIT, cập nhật 2026-10, có breaker + bulkhead + adaptive limiter) xếp trên `sony/gobreaker` (MIT, chỉ breaker).
- **Tách pool:** bot nội bộ/đã xác minh và bot công khai dùng pool worker riêng; egress đi qua proxy chống SSRF (đã có ở bot report).
- **Webhook reply** (method trong body response) tiết kiệm một round-trip cho bot trả lời ngay; giữ như Telegram.

## 4. Đường gửi thông lượng cao

### 4.1 Rate limit theo tier (đề xuất, cấu hình được; token bucket ở core)

| Phạm vi | Telegram (FAQ, "soft") | Default | Verified bot | Alert/system bot nội bộ |
|---|---|---|---|---|
| Toàn bot | ~30 msg/s | 30/s | 300/s | 1.000+/s |
| Mỗi group/channel | 20/phút group | 1/s, burst 20 | 5/s, burst 50 | 20/s, burst 200, **bắt buộc bật coalescing** |
| Mỗi DM người dùng | 1/s | 1/s, burst 5 | 5/s | 10/s |
| Mỗi incoming webhook URL | Slack 1/s; GChat 1/s/space | 5/s, burst 30 | 20/s, burst 100 | Theo hợp đồng |
| Bulk: recipient/lần gọi | — | 100 | 1.000 | 1.000 (chia batch) |
| Mỗi người nhận, mọi bot, lane marketing | — | 60/giờ | 60/giờ | Không áp cho lane 0–1 |

Khi vượt: HTTP 429 dạng Telegram (`parameters.retry_after`) cộng header `Retry-After` và `X-RateLimit-Limit/Remaining/Reset-After` (giống Discord) để thư viện nào cũng tự lùi được. Trần vật lý cần nhớ: mỗi chat có một dòng `chat_pts` bị khóa trong lúc commit, nên một chat "nóng" bị giới hạn ở cỡ vài trăm đến nghìn tx/s (ước tính, cần đo). Khi chạm trần, gom micro-batch 5–10 ms theo chat thành một transaction.

### 4.2 Bulk/broadcast API (namespace mở rộng, không đụng Bot API chuẩn)

- `POST /bot<token>/x/sendBulk` `{recipients:[chat_id…], text, entities|parse_mode, priority, idempotency_key, notify}` → `202 {bulk_id, accepted, rejected:[{chat_id, reason}]}`. Mỗi recipient sinh một message trong DM của bot (fan-out on write, insert theo batch trong ít transaction). Trạng thái từng recipient xem bằng `x/getBulkStatus` hoặc callback.
- Chỉ gửi tới người đã `/start` bot hoặc đã opt-in (giữ luật Telegram chống spam).
- **Channel:** dùng `sendMessage` vào channel. Message chỉ ghi **một lần** (fan-out on read, theo backend report); fan-out chỉ xảy ra ở push, do push worker xử lý theo batch subscriber. Không dùng FCM topic, vì cần áp mute/quiet hours cho từng người. FCM HTTP v1 không có batch endpoint (đã gỡ năm 2024); SDK gửi từng request song song qua HTTP/2, nên batch chỉ là chuyện của mình.

### 4.3 Lane ưu tiên

| Lane | Nội dung | Ai được dùng | Push | Mục tiêu |
|---|---|---|---|---|
| 0 Transactional | OTP-like, xác nhận giao dịch | Bot verified, khai báo trước | high priority; iOS `time-sensitive` nếu user cho phép | Tới provider p99 ≤ 1 s |
| 1 Alert | Monitoring, CI/CD, billing | Bot/webhook hệ thống | high priority, coalesce | Tới provider p99 ≤ 1 s |
| 2 Interactive | Bot trả lời người dùng | Mọi bot | normal/high theo chat | p99 ≤ 2 s |
| 3 Bulk/marketing | Thông báo hàng loạt | Bot verified | normal, giãn theo giờ | Best-effort, không chặn lane khác |

Mỗi lane có hàng đợi và worker pool riêng; scheduler weighted-fair (ví dụ 8:4:2:1). **Dành riêng quota FCM** (600k message/phút/project) cho lane 0–1, ví dụ lane 3 không được dùng quá 50%. Lane do server gán theo loại bot, không để client tự khai.

### 4.4 Dedupe, gộp alert, im lặng

- **`idempotency_key`** (header `Idempotency-Key`, IETF draft rev 07, 2026-04, chưa thành RFC; hoặc field body): unique `(sender_id, key)` trong 24 h. Retry trả lại đúng response cũ. Ràng buộc nằm trong cùng transaction message, nên không có cửa sổ race.
- **`group_key`** (Alertmanager `groupKey`; native có thể đặt tay): nếu trong chat đã có message "mở" cùng key, mặc định **sửa tại chỗ** (cập nhật nội dung, đếm "×N", trạng thái firing → resolved), tùy chọn `on_repeat: edit|thread|new`. Chỉ push khi **đổi trạng thái hoặc tăng severity**; lặp lại thì sửa im lặng. Alertmanager đã gộp sẵn ở nguồn (mặc định `group_wait` 30 s, `group_interval` 5 m, `repeat_interval` 4 h), nên phía mình chỉ cần gộp tiếp cho các nguồn không gộp.
- **Chống bão push:** mỗi (user, chat) tối đa 1 push có âm thanh mỗi 30 s; phần còn lại im lặng kèm tóm tắt "12 cảnh báo mới". Android dùng notification `tag` theo chat/group_key để thay notification cũ. **Không lạm dụng collapsible message**: FCM chỉ cho burst 20 message collapsible mỗi app mỗi máy, hồi 1 message mỗi 3 phút; giới hạn chung là 240/phút và 5.000/giờ mỗi máy Android. iOS dùng `apns-collapse-id` (≤64 byte) và `thread-id`.
- **`notify`**: `normal` | `silent` (= Telegram `disable_notification`, nghĩa là vẫn có notification nhưng **không âm thanh**) | `none` (không push, không tăng unread, giống Mattermost `silent`). Map Discord flag `SUPPRESS_NOTIFICATIONS` → `none`.
- **Mute/quiet hours:** mute chat và lịch Không làm phiền (mặc định múi giờ Asia/Saigon) luôn thắng lane 1–3. Lane 0 chỉ vượt quiet hours nếu user bật cho bot đó; không bao giờ vượt mute. Không dùng `critical` của iOS vì cần entitlement Apple cấp riêng.

## 5. Công nghệ queue cho path này

| Lựa chọn | Độ trễ (bằng chứng) | Bền + khớp tx pts | Thứ tự theo key | Retry/backoff | Ops | Hợp với path này |
|---|---|---|---|---|---|---|
| **PG outbox + SKIP LOCKED + eager dispatch** | Đường nóng không chờ poll; sweep fallback 200 ms (River mặc định cooldown 100 ms, poll 1 s) | **Cùng transaction**, không dual-write | Theo cột key + seq | Cột `run_at` | Không thêm hạ tầng; lo bloat/vacuum khi churn cao | **v1** |
| PG `LISTEN/NOTIFY` | `NOTIFY` lấy khóa toàn cục lúc commit, tuần tự hóa mọi commit (Recall.ai sập 3 lần 2025-03); DBOS gom batch đạt 60k write/s, trễ 15–100 ms; bản vá upstream đang ở dạng đề xuất | Chỉ là tín hiệu | — | — | Thấp | Chỉ làm tín hiệu đánh thức, gom batch; không gửi theo từng message |
| Redis Streams | Dưới 1 ms trong RAM (ước tính, chưa có benchmark độc lập) | AOF `everysec` có thể mất ≤1 s; vẫn phải đi qua outbox | Theo stream (hash key → N stream) | Không có delayed retry native | Đã có Redis | Hợp lệ nhưng phải tự viết delay/DLQ |
| **NATS JetStream** | Chưa có số p99 công bố, phải đo bằng `nats bench` (R3 file storage) | Qua outbox relay | Subject theo bot/chat, `MaxAckPending` | `BackOff []Duration`, `MaxDeliver`, AckWait | TB; Apache-2.0, v2.15.1 (2026-10-09) | **Khi scale**; dùng chung với routing gateway |
| Kafka/Redpanda | Kafka p99 5 ms ở 200 MB/s (Confluent 2020, vendor) | Qua CDC | Theo partition → **HOL blocking**: một bot chậm chặn cả partition | Phải tự làm retry topic | Cao; Redpanda là BSL | Chỉ cho CDC/analytics/search |

**v1:** handler commit transaction (message, pts, outbox với `lane`, `kind=push|bot_update|status_cb`), rồi `afterCommit` đẩy thẳng việc vào channel trong process (dispatcher cùng binary) và publish Redis pub/sub cho gateway. Sweep `SKIP LOCKED` mỗi 200 ms nhặt việc bị rơi (process chết giữa chừng). Khi đạt ngưỡng, ví dụ hàng đợi PG churn vượt khoảng 5k job/s kéo dài, hoặc dispatcher tách thành service riêng: relay outbox → JetStream (stream theo lane, subject `bot.<id>`, `push.<shard>`). Lúc đó PG vẫn là nguồn sự thật và pts không đổi.

## 6. Fast path và ngân sách độ trễ

```
Sender ──HTTPS keep-alive──▶ Ingest (Go, cùng binary API)
  1 auth token (cache in-proc, hash) → 2 translate format → 3 render entities
  4 rate limit (Redis Lua, bucket nhiều tầng) → 5 lane + group_key lookup
  6 PG TX: INSERT message ON CONFLICT(idempotency) · chat seq · pts (user/chat) · outbox → COMMIT
  7 ◀── 200 {message_id}  (async: 202 trước bước 6 chỉ cho bulk)
  8 afterCommit: PUBLISH Redis u.<uid>/c.<chat> ──▶ Gateway ──WS──▶ client online (ack → "delivered")
  9 afterCommit: dispatcher push: presence (foreground? bỏ qua) → mute/quiet → coalesce → lane queue
 10 Push worker (HTTP/2 pool FCM v1 / APNs .p8) ──▶ provider ack ──▶ thiết bị
 11 Client/NSE nhận push → báo "delivered" (best-effort) ; outbox sweep 200 ms = lưới an toàn
```

| Đoạn | p50 | p99 | Ghi chú |
|---|---|---|---|
| 1–5 auth, parse, render, rate limit | 1 ms | 3 ms | Token cache trong process; Redis cùng AZ |
| 6 PG transaction (fsync, sync replica cùng DC) | 4 ms | 20 ms | Phần lớn thời gian ở đây; chat nóng cần micro-batch |
| **POST → 200 (server-side)** | **≤ 15 ms** | **≤ 50 ms** | Không tính RTT mạng của sender |
| 8 Redis pub/sub → gateway → ghi socket | 2 ms | 10 ms | |
| Last-mile tới client (4G/wifi VN) | 30–60 ms | 200 ms | Không kiểm soát được |
| **Webhook nhận → client online thấy** | **≤ 100 ms** | **≤ 300 ms** | Chặt hơn đích user→user 500 ms của backend report vì chỉ có một last-mile |
| 9 quyết định push + xếp lane | 2 ms | 10 ms | |
| 10 FCM/APNs HTTP/2 (VN → endpoint khu vực) | 60–150 ms | 500 ms | Kết nối giữ ấm, không mở mới mỗi lần |
| **Webhook nhận → provider ack (lane 0–1)** | **≤ 200 ms** | **≤ 1 s** | Khớp backend report (enqueue→provider p99 ≤ 1 s) |
| Provider → hiển thị trên máy | ~1–2 s (ước tính) | Vài giây tới phút (Doze, normal priority) | Chỉ quan sát, không cam kết SLO |

**Cách đo:**
- Mỗi message có trace ID (OpenTelemetry) và các mốc `received_at, committed_at, published_at, ws_acked_at, push_sent_at, provider_acked_at, device_received_at`. Histogram theo lane/format/bot.
- **Canary tổng hợp:** mỗi 10 s, mỗi format (native, Telegram, Slack, Discord) bắn vào chat canary. Một headless client WebSocket đo tới-client. Một Android và một iPhone thật (đặt ở văn phòng, app chế độ canary) đo tới-máy qua `onMessageReceived` / Notification Service Extension rồi báo về. Đồng hồ đồng bộ NTP, hoặc dùng round-trip ack. Cảnh báo khi p99 vượt ngân sách 5 phút liên tiếp.
- FCM Aggregated Delivery Data (Android) cho tỉ lệ bị trì hoãn/throttle (`delayedMessageThrottled`); dữ liệu trễ tới 24 h nên chỉ dùng cho xu hướng.

## 7. Observability cho bên gửi

- **Trạng thái mỗi message:** `accepted` (qua validate) → `sent` (đã commit) → `delivered` (≥1 thiết bị của người nhận ack qua WS hoặc NSE/onMessageReceived) → `read`, hoặc `failed{reason}`. Với group/channel chỉ trả số đếm tổng hợp (`delivered_count`, `read_count`), không trả từng người. Mô hình này giống Twilio (queued/sent/delivered/undelivered/failed; callback có thể **đến không theo thứ tự** → luôn kèm `seq` trạng thái).
- **Kênh trả trạng thái:** `x/getMessageStatus`; `status_callback_url` cho từng request hoặc từng webhook/bot, ký theo Standard Webhooks; với bot thì thêm update type mở rộng `x_message_status` qua `getUpdates`/webhook (opt-in qua `allowed_updates`, nên thư viện cũ không vỡ).
- **Retry/DLQ:** bên gửi tự retry với `idempotency_key`. Phía mình: outgoing (bot webhook, status callback) retry theo lịch Svix/Standard Webhooks (ngay, 5 s, 5 m, 30 m, 2 h, 5 h, 10 h, 10 h); `410` thì tắt endpoint; lỗi liên tục 5 ngày thì disable và báo chủ bot. Hết lượt thì vào DLQ, xem và replay được từ dashboard.
- **Dashboard theo bot/webhook:** volume, p50/p99 từng chặng, tỉ lệ 4xx/429/5xx, số bị coalesce, pending, trạng thái circuit, 20 lỗi gần nhất kèm payload đã che secret. **Audit log** (append-only, giữ ≥1 năm): tạo/xoay/thu hồi secret, đổi URL, đổi tier, ai và từ IP nào.

## 8. Security

| Hạng mục | Khuyến nghị |
|---|---|
| Secret của incoming webhook | 256-bit, có **tiền tố nhận diện** (ví dụ `inetw_…`) để sau này đăng ký GitHub secret scanning (Slack webhook URL đang được quét công khai, có push protection); chỉ lưu hash, hiện một lần. Nhận cả `Authorization: Bearer` để secret không nằm trong log URL khi công cụ cho phép header |
| Rotation | Secret mới và cũ cùng hợp lệ trong thời gian ân hạn (mặc định 24 h, tối đa 7 ngày); có nút thu hồi tức thì. Bot token theo cơ chế `revoke` của bot report |
| Ràng buộc đích | Một webhook = một chat, **không cho override kênh** (theo Slack, không theo Mattermost); `@all`/mention hàng loạt cần quyền riêng |
| Xác thực nguồn (tùy chọn) | Kiểm `X-Gitlab-Token`, `Sentry-Hook-Signature`, Standard Webhooks khi adapter tương ứng bật |
| Ký outgoing | Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(id.ts.body)>`, secret `whsec_`, gửi nhiều chữ ký khi xoay key; v2 có `v1a` (Ed25519). Bot giữ thêm `X-Telegram-Bot-Api-Secret-Token` để tương thích. Bên nhận kiểm timestamp ±5 phút |
| IP allowlist | Tùy chọn theo webhook (CIDR). Công bố dải IP egress của mình cho bên nhận outgoing |
| Kích thước | Body ≤ 256 KB; text ≤ 4.096 ký tự UTF-16 (ngang Telegram). Format Slack/Discord dài hơn thì cắt và thêm "…(xem đầy đủ)" với link, không tách nhiều tin như Mattermost (tránh bão push); embed tối đa 10 |
| Lạm dụng | Rate limit nhiều tầng (mục 4.1); chặn bot/webhook khi người nhận report spam; 404/401 liên tục từ một IP thì chặn tạm (kiểu Discord 10k lỗi/10 phút); bulk chỉ tới người đã opt-in; quét link độc hại trong channel công khai (v2) |

## 9. Phạm vi v1 và sau này

| Hạng mục | v1 | v1.1 | v2 / khi scale |
|---|---|---|---|
| Ingest format | Native, Telegram, Slack-compat, adapter Alertmanager | Discord-compat (+`/slack`) | GitLab/Sentry adapter, template khai báo, `chat.postMessage` compat cho Grafana/Zabbix |
| Gửi | Lane 0–3, rate limit tier, `idempotency_key`, `group_key` edit-in-place, `notify` | `sendBulk` + trạng thái | Micro-batch theo chat owner |
| Queue | PG outbox + eager dispatch + sweep | — | Relay → NATS JetStream |
| Bot outgoing | Bulkhead theo bot, pool kết nối, breaker | Adaptive concurrency | Pool tách theo region |
| Observability | Trạng thái `sent/delivered`, dashboard cơ bản, audit log, canary web | Status callback, DLQ UI, canary thiết bị thật | Số đếm read tổng hợp, FCM delivery data |
| Security | Secret có tiền tố + hash, rotation có ân hạn, ký Standard Webhooks, giới hạn kích thước | IP allowlist | Ed25519 `v1a`, đăng ký secret scanning |

Độ phức tạp: v1 tier **L** (nhiều module: ingest, core send, push, bot dispatcher, observability), v1.1 **M**, v2 **L**.

## 10. Rủi ro áp dụng

- **Hàng đợi trên Postgres** dễ bloat khi churn cao. Cần partition hoặc xóa theo batch và tune autovacuum từ đầu; đo trước khi vượt vài nghìn job/s.
- **Slack-compat là "tập con mờ":** `blocks`/`attachments` rất rộng. Chỉ render tập tối thiểu (section/fields/color/title_link) và test bằng payload thật lấy từ Grafana, Alertmanager, Jenkins, GitLab (contract test).
- **Các tích hợp có thể đổi:** Grafana có thể thêm base URL cho Telegram, GitLab có thể siết Mattermost URL. Ma trận ở mục 2.2 cần re-verify mỗi quý.
- **Thời gian từ provider tới máy** (FCM/APNs) là hộp đen; Android Doze và nhà sản xuất máy (OEM) "diệt" app nền có thể làm trễ vài phút. Không hứa SLO cho đoạn này.
- **River** (Go, PG queue, MPL-2.0, v0.49 vẫn trước 1.0) có thể thay outbox tự viết, nhưng nó dùng `NOTIFY` để đánh thức, nên phải đánh giá dưới tải ghi cao trước khi chọn.

## 11. Giới hạn của research

- Chưa benchmark gì. Mọi con số p50/p99 của mình là **mục tiêu đề xuất**, trừ các số trích nguồn. Chưa có số p99 công bố đáng tin cho JetStream và Redis Streams.
- Chưa đọc source Jenkins Discord plugin, Grafana webhook custom payload, và payload Sentry chi tiết.
- Không khảo sát SMS/Zalo ZNS làm kênh dự phòng cho OTP; nếu OTP là yêu cầu thật thì cần làm riêng.
- Ngày tắt Teams O365 connector lấy từ nguồn thứ cấp (message center MC1181996 qua bên thứ ba).

## Unresolved questions

1. "OTP-like" có phải OTP thật không? Nếu có thì cần kênh dự phòng (SMS/ZNS) và cam kết pháp lý; push không đảm bảo giao.
2. Có cho bên gửi xem trạng thái `read` không? Nội bộ công ty thì chấp nhận được, còn với bot công khai thì đây là vấn đề quyền riêng tư. Đề xuất: opt-in theo tổ chức.
3. Lượng alert dự kiến lúc cao điểm (message/s, số chat nhận, số người mỗi chat) là bao nhiêu? Con số này quyết định khi nào chuyển sang JetStream và có cần micro-batch theo chat ngay ở v1 không.
4. Người nhận có nằm ngoài iNET (khách hàng hosting nhận billing/alert) không? Nếu có thì lane 3 và luật chống spam phải chặt hơn và cần quy trình verify bot.
5. Công cụ nội bộ đang dùng thực tế là gì (Zabbix hay Prometheus, GitLab self-managed bản nào)? Câu trả lời quyết định thứ tự ưu tiên Discord-compat và các adapter.

## Nguồn

- Slack: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/ · https://docs.slack.dev/apis/web-api/rate-limits
- Discord: https://docs.discord.com/developers/resources/webhook · https://docs.discord.com/developers/topics/rate-limits
- Mattermost: https://docs.mattermost.com/developers/integrate/webhooks/incoming
- Google Chat: https://developers.google.com/workspace/chat/quickstart/webhooks
- Teams retirement: https://www.itelio.com/en/microsoft-message-center/MC1181996 (thứ cấp)
- Rocket.Chat: https://docs.rocket.chat/docs/integrations
- Alertmanager: https://github.com/prometheus/alertmanager/blob/main/docs/configuration.md
- Grafana: https://github.com/grafana/alerting/tree/main/receivers (`telegram/v1/telegram.go`, `slack/v1/slack.go`)
- GitLab: `app/models/concerns/integrations/base/{discord,telegram}.rb` tại https://gitlab.com/gitlab-org/gitlab · https://docs.gitlab.com/user/project/integrations/discord_notifications/
- Uptime Kuma: https://github.com/louislam/uptime-kuma/tree/master/server/notification-providers
- Zabbix: https://github.com/zabbix/zabbix/tree/master/templates/media
- Jenkins Slack: https://github.com/jenkinsci/slack-plugin (`StandardSlackService.java`) · https://plugins.jenkins.io/telegram-notifications/
- Sentry: https://docs.sentry.io/integrations/integration-platform/webhooks/
- Standard Webhooks: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md · Svix retries: https://docs.svix.com/retries
- IETF Idempotency-Key: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Go Transport: https://github.com/golang/go/blob/master/src/net/http/transport.go
- FCM quotas: https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas · Delivery data: https://firebase.google.com/docs/cloud-messaging/understand-delivery
- NOTIFY lock: https://www.recall.ai/blog/postgres-listen-notify-does-not-scale · https://dbos.dev/blog/postgres-listen-notify-scalability
- Kafka benchmark: https://www.confluent.io/blog/kafka-fastest-messaging-system/
- River: https://github.com/riverqueue/river (`client.go`) · NATS: https://github.com/nats-io/nats-server (`server/consumer.go`)
- GitHub secret scanning patterns: https://github.com/github/docs/blob/main/src/secret-scanning/data/pattern-docs/fpt/public-docs.yml
- Twilio status: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
