# Xia: Thiết kế ứng dụng chat độc lập, hiệu năng và kiến trúc học từ Telegram

> Cập nhật 2026-10-13 11:54: user xác nhận sản phẩm chat và bot **hoàn toàn độc lập với Telegram**. "Giống Telegram" chỉ là hiệu năng và kiến trúc. Mọi đề xuất tương thích Telegram (Bot API wire-level, `-100` chat id, `message_id` int32, format webhook `sendMessage`, tên BotFather, port parser tdlib) đã bị loại bỏ. Plan: [chat-platform-v1](../261013-0448-chat-platform-v1/plan.md).

Chế độ: `--port` (viết lại theo stack riêng, chỉ học kiến trúc, không copy code GPL).
Tên sản phẩm: **cấu hình được** — dùng placeholder `{{APP_NAME}}`; "chat-inet" chỉ là tên thư mục.
Ngày: 2026-10-13 (Asia/Saigon).

> Cập nhật 2026-10-13 (sau red-team và validation): đăng ký chỉ bằng email; bot quản lý qua Developer Console + SDK TS/Python/Go; thông báo chỉ trả accepted + bộ đếm; RPO = 0 bằng replica đồng bộ + `server_epoch`. Chi tiết trong `## Validation Log` của plan.

## 1. Kết quả mong muốn

Ứng dụng chat công khai, độc lập, đạt hiệu năng ngang Telegram, web-first, đóng gói Capacitor (iOS/Android) và Tauri v2 (macOS/Windows/Linux) từ một codebase TypeScript.

Yêu cầu tối thiểu (do user đặt, không được cắt):

1. **Tốc độ cực nhanh ngang Telegram** — mở app, mở chat, gửi/nhận, cuộn lịch sử.
2. **Nền tảng Bot mạnh ngang Telegram** — API, SDK và tên gọi riêng.
3. **Tìm kiếm lịch sử tin nhắn** — nhanh, hỗ trợ tiếng Việt không dấu.
4. **Gửi thông báo qua Bot và webhook với tốc độ xử lý cực nhanh.**

7 nguyên tắc sản phẩm: (1) Core first, (2) Speed matters, (3) Simple by default, (4) Cloud-enabled, (5) Privacy by design, (6) Platform over features, (7) Scale from the beginning.

## 2. Quyết định đã chốt với user

| Quyết định | Lựa chọn | Hệ quả |
|---|---|---|
| Quyền riêng tư | Mô hình Telegram: cloud chat (TLS + mã hoá at-rest, server search, bot, đa thiết bị); secret chat E2E 1-1 ở giai đoạn sau | Data model phải chừa chỗ cho loại chat `secret` (không index, không bot, một thiết bị) |
| Đối tượng / quy mô | Công khai, hàng triệu user trong 12–24 tháng | Contract dữ liệu thiết kế cho shard ngang từ ngày đầu; v1 triển khai cỡ ~100k; chống spam/abuse là yêu cầu v1 |
| Frontend | React 19 (+ React Compiler) | Store ngoài React, subscribe hạt mịn; hot path viết tay, có ngân sách render đo trong CI |
| Backend | Go | Gateway WebSocket, API, Bot API gateway, webhook ingest/dispatch đều bằng Go |

Mặc định áp dụng: self-host datacenter Việt Nam; không tương thích bất kỳ thành phần nào của Telegram; một loại group duy nhất; OTP thật cần kênh dự phòng SMS/ZNS — sau v1.

## 3. Source manifest

| Nguồn | Commit | License | Cách dùng |
|---|---|---|---|
| github.com/Ajaxy/telegram-tt | `090e38f1dffec3e0a9aefbec8159a9931fbeec8f` | GPL-3.0 | Học kỹ thuật, **cấm copy code** |
| github.com/morethanwords/tweb | `ed0b0def153959ed9f96eff078469837bfc30e0f` | GPL-3.0 | Học kỹ thuật, **cấm copy code** |
| github.com/tdlib/telegram-bot-api | `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1` | BSL-1.0 | Chỉ học ngữ nghĩa giao update (thứ tự, retry, hết hạn); không port code |
| github.com/teamgram/teamgram-server | `708fb9536f60e15d9bf4f1c302aa4251bfefab19` | Apache-2.0 | Tham khảo sync; không lấy bố cục 12 service |
| core.telegram.org (api/updates, bots/api 10.3, webapps) | — | Tài liệu | Contract tham chiếu |

Báo cáo chi tiết:

- [Kỹ thuật tốc độ client web](researcher-261013-1120-telegram-web-client-speed.md)
- [Nền tảng Bot](researcher-261013-1120-telegram-bot-platform.md)
- [Backend sync và tìm kiếm](researcher-261013-1120-backend-sync-search.md)
- [Client đa nền tảng](researcher-261013-1120-cross-platform-client.md)
- [Pipeline thông báo Bot/webhook](researcher-261013-1120-notification-pipeline.md)

## 4. Giải phẫu nguồn (cái làm Telegram nhanh)

- **Sync**: mỗi user có update log với `pts` tăng đơn điệu; client phát hiện khoảng trống và gọi `getDifference`. Realtime là best-effort, đúng đắn đến từ catch-up.
- **Client**: kết nối + giải mã + sắp xếp update chạy trong (Shared)Worker; scheduler tách pha đọc/ghi DOM; message list chỉ ~80–120 node; snapshot "màn hình cuối" trong storage để render trước khi có mạng; optimistic send với id tạm giữ nguyên render key.
- **Payload**: message mang kích thước media + thumbnail nhỏ inline để không nhảy layout.
- **Bot**: bot là user đặc biệt trong core; Bot API server là lớp HTTP mỏng; privacy mode và rate limit cưỡng chế ở core.

## 5. Dependency matrix

Repo trống, nên mọi thành phần là `NEW`. Không có `CONFLICT` với code cũ; xung đột duy nhất là license GPL (đã chặn bằng chính sách "không copy").

| Thành phần nguồn | Tương đương local | Trạng thái |
|---|---|---|
| MTProto + pts/qts | WebSocket JSON/Protobuf + pts per-user log | NEW |
| Teact + fastdom | React 19 + scheduler đọc/ghi DOM tự viết | NEW |
| IndexedDB cache | SQLite (WASM/OPFS, Capacitor plugin, rusqlite) + FTS5 | NEW |
| Bot API server (TDLib) | Bot API riêng (Go) + OpenAPI + SDK TS/Python/Go | NEW |
| — (Telegram không có) | Incoming webhook đa format | NEW |
| Branding Telegram | `brand.config` một nguồn | NEW |

## 6. Bảng quyết định kiến trúc

| # | Quyết định | Cách của nguồn | Đề xuất | Nguyên tắc | Rủi ro |
|---|---|---|---|---|---|
| 1 | ID | message_id per-chat | Snowflake nội bộ; ra ngoài `(chat_id, seq)`; mọi id lộ ra < 2^53 (an toàn JavaScript); mọi chat kể cả 1-1 có chat_id riêng kèm `type` | 7, 6 | Critical |
| 2 | Sync | pts/qts/getDifference | Như nguồn; pts cấp trong cùng transaction Postgres; chat ≤200 thành viên fan-out on write, lớn hơn dùng log per-chat | 4, 2 | Critical |
| 3 | Định dạng text | text + entities UTF-16 | text + entities, offset UTF-16 (chuỗi JS là UTF-16) | 6 | Critical |
| 4 | Lưu trữ | (đóng) | Postgres partition theo `chat_id`, sharding key cố định từ đầu; ScyllaDB chỉ khi vượt ngưỡng đo được | 7 | Trung bình |
| 5 | Gateway | MTProto | Go WebSocket, stateless, Redis pub/sub v1 → NATS khi scale; typing/presence chỉ tới session đang mở chat | 2, 7 | Thấp |
| 6 | Tìm kiếm server | messages.search | Outbox → indexer → Meilisearch CE (v1), OpenSearch khi scale; lọc ACL theo membership + re-check Postgres; Postgres là nguồn sự thật | 2, 5 | Trung bình |
| 7 | Tiếng Việt | — | Một spec fold (bỏ dấu + `đ→d`) + bộ test vector dùng chung client (TS) và server (Go). Đã kiểm chứng FTS5 `remove_diacritics 2` không fold `đ` | 2, 3 | Thấp |
| 8 | Bot | Bot API | Bot API riêng `/bot/v1`, đặc tả OpenAPI, SDK chính thức TS/Python/Go; tính năng ngang Telegram (lệnh, bàn phím, callback, inline, Mini Apps, file, quản trị group); giữ ngữ nghĩa giao update đã kiểm chứng | 6 | Trung bình |
| 9 | Webhook vào | — | Một ingest path; v1 nhận: JSON riêng, Bot API của ta, Slack-compatible (trả `ok`), Alertmanager native; Discord ở v1.1 | 6, 2 | Thấp |
| 10 | Fast path gửi | — | 1 transaction (message + pts + outbox + idempotency) → trả 200 → Redis fan-out + push dispatcher; outbox sweep 200 ms làm lưới an toàn; 4 làn ưu tiên; `group_key` gộp alert; không dùng LISTEN/NOTIFY per message | 2 | Trung bình |
| 11 | Webhook ra (tới bot) | tdlib logic | Concurrency + circuit breaker per bot; HTTP keep-alive pool nâng theo `max_connections`; retry 1 s nhân đôi, trần 60–120 s; giữ update 24 h | 2, 6 | Thấp |
| 12 | Frontend | Teact | React 19 + Compiler; store ngoài React (`useSyncExternalStore` theo id); virtual list tự viết; snapshot cold start; optimistic send | 2 | Trung bình |
| 13 | Local storage | IndexedDB | Một interface batch-atomic; web: SQLite WASM `opfs-sahpool` trong worker, một tab sở hữu DB; Capacitor: `@capacitor-community/sqlite`; Tauri: rusqlite + command | 4, 2 | Trung bình |
| 14 | Mobile nền | — | Không giữ socket nền; push → resume → getDifference; notification extension native (Swift/Kotlin); badge do server tính | 2 | Cao |
| 15 | Desktop nền | — | Tauri: tray, autostart, deep link, updater; vá throttle cửa sổ ẩn (Web Lock trên Windows/Linux) | 2 | Cao |
| 16 | Media | MTProto + Service Worker | HTTP Range trên S3-compatible + CDN, upload resumable; không dùng Service Worker streaming (vỡ trên Capacitor iOS) | 2 | Thấp |
| 17 | Branding | — | `brand.config` duy nhất sinh ra manifest web, Capacitor config, Tauri config, push sender, host Bot API | 3 | Thấp |
| 18 | Secret chat | E2E | Chừa chỗ trong data model ở v1; triển khai giai đoạn sau | 5 | Trung bình |

## 7. Ngân sách latency (mục tiêu, chưa benchmark)

| Chỉ số | p50 | p99 |
|---|---|---|
| Gửi → ack | ≤ 60 ms | ≤ 250 ms |
| Tới người nhận đang online | ≤ 150 ms | ≤ 500 ms |
| Mở chat từ cache local | ≤ 50 ms | ≤ 100 ms |
| Tìm kiếm | ≤ 100 ms | ≤ 500 ms |
| Webhook POST → 200 (server-side) | ≈ 15 ms | ≈ 50 ms |
| Webhook → client online thấy tin | ≤ 100 ms | ≤ 300 ms |
| Push được FCM/APNs nhận | ≤ 200 ms | ≤ 1 s |

Đo bằng canary bot từ mạng Viettel/VNPT/FPT, RUM phía client, histogram phía server.

## 8. Risk score

Critical: #1 ID, #2 sync, #3 entities UTF-16 — cả ba xử lý bằng cách chốt contract trước khi viết feature. Cao: #14, #15 (vòng đời nền mobile/desktop). Kết luận: **Medium**, đã giải quyết các giả định critical với user; được phép lập plan với điều kiện phase đầu tiên là chốt contract.

## 9. Câu hỏi còn mở (không chặn plan)

- Đăng ký tài khoản: số điện thoại (cần SMS OTP, có chi phí) hay email, hay cả hai.
- Thông báo "OTP-like" có phải OTP thật không; nếu có cần kênh dự phòng SMS/Zalo ZNS.
- Người gửi webhook có được xem trạng thái "đã đọc" không (đề xuất opt-in theo tổ chức).
- Giới hạn độ dài tin nhắn/caption của ta: đề xuất đếm theo code point, chốt trong ADR.
- Mini Apps: dùng SDK bridge riêng (`packages/miniapp-sdk`).
- Tạo bot: plan làm cả bot hệ thống lẫn Developer Console; cần xác nhận.
- FTS5 trong build SQLCipher iOS và giới hạn thời gian của iOS notification extension — cần kiểm tra trên thiết bị.
