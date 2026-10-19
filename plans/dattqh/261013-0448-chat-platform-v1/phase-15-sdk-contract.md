---
phase: 15
title: "Hợp đồng chung của 3 SDK bot (TS, Python, Go)"
status: in-progress
effort: "L"
---

# Hợp đồng chung của 3 SDK bot

Quyết định (Jev, 2026-10-17): model và method **sinh từ OpenAPI** bằng `server/cmd/sdkgen` (0,63); runtime **chỉ dùng thư viện chuẩn** (0,56); SDK **nằm trong monorepo**, cài từ đường dẫn hoặc git tag, registry dựng khi ra mắt (0,81); conformance là **test Go chạy server thật** + bot mẫu chạy như tiến trình con (0,89).

## Bố cục

| | TypeScript | Python | Go |
|---|---|---|---|
| Thư mục | `sdk/ts/` | `sdk/python/` | `sdk/go/` |
| Tên | package `@app/sdk` (pnpm workspace) | dist `chat-bot-sdk`, import `chatbot` | module `github.com/achoo254/chat-next/sdk/go`, package `chatbot` |
| Mã sinh (không sửa tay) | `src/generated.ts` | `chatbot/_generated.py` | `generated.go` |
| Môi trường | Node ≥ 22, `fetch`/`http`/`crypto` có sẵn, không dependency runtime | Python ≥ 3.11, chỉ stdlib | Go ≥ 1.24, chỉ stdlib |
| Test | `pnpm --filter @app/sdk test` (vitest) | `python3 -m unittest discover -s tests` | `go test ./...` |

Sinh lại mã: `cd server && go run ./cmd/sdkgen`; `go test ./cmd/sdkgen` đỏ khi OpenAPI đổi mà chưa sinh lại.

## Client

- Tạo bằng token và tuỳ chọn: `baseUrl` (mặc định `https://chat.hoandat.com/bot/v1`), timeout mỗi request (mặc định 60 s; long poll cộng thêm `timeout` của poll), số lần thử lại (mặc định 3).
- Mọi request có `Authorization: Bearer <token>`; body JSON `application/json`. Kết quả là `result` của envelope; `ok: false` thành lỗi `ApiError` có `status` (HTTP), `code`, `description`, `retryAfter` (giây, 0 khi không có). Không bao giờ phân nhánh theo `description`.
- Thử lại tự động **chỉ** khi `429 rate_limited` hoặc `503 unavailable`: chờ `retry_after` (envelope, hoặc header `Retry-After`), không có thì 1 s; quá số lần thì ném lỗi. Không thử lại lỗi khác hay lỗi mạng của request có body (có thể đã chạy); `GET` lỗi mạng thì thử lại như 503.
- Không in token ra log hay chuỗi lỗi.
- Tải file:
  - `InputFile`: tên file + dữ liệu (TS `Blob | Uint8Array`, Python `bytes` hoặc file nhị phân đã mở, Go `io.Reader`).
  - `sendMediaUpload` / `send_media_upload` / `SendMediaUpload`: multipart theo `SendMediaUpload` (part `file` mang tên file; `entities` là chuỗi JSON).
  - `sendAlbumUpload`: multipart theo `SendAlbumUpload` (`items` là chuỗi JSON của `AlbumItem` có `attach`; mỗi file một part tên đúng `attach`).
  - `downloadFile(file)`: GET `file.url` (không gửi token), trả bytes.

## Nhận update

- Long poll: `poll`/`run_polling`/`Poll(ctx)` gọi `getUpdates` với `offset` = `update_id` cuối + 1, `timeout` 50; xử lý tuần tự từng update; dừng khi được yêu cầu (AbortSignal / cờ dừng / ctx). `409 conflict` (poll khác hoặc đã có webhook) là lỗi dừng vòng lặp. Lỗi mạng, `5xx`, `429`: chờ (1 s nhân đôi tới 30 s, hoặc `retry_after`) rồi tiếp. Lỗi trong handler: ghi log, update vẫn được xác nhận (không kẹt).
- Webhook:
  - Hàm kiểm thuần: `verifyWebhook(headers, rawBody, secret, now)` đúng khi `X-Bot-Api-Secret-Token` bằng secret **và** `X-Bot-Signature` = `v1=` + hex(HMAC-SHA256(key = secret, message = `X-Bot-Timestamp` + "." + raw body)) **và** timestamp lệch đồng hồ ≤ 5 phút. So sánh hằng thời gian.
  - Handler HTTP (TS: `(req, res)` của `node:http`; Python: ứng dụng WSGI + `serve_webhook(host, port)` bằng `http.server`; Go: `http.Handler`): sai kiểm → `401` không body; body > 1 MiB → `413`; trùng `update_id` đã xử lý gần đây (giữ 1000 id) → `200` không chạy lại; handler trả `WebhookAnswer` thì trả `200` với JSON đó, không thì `204`; handler lỗi → `500` (server sẽ gửi lại).
  - Chỉ nhận `POST`; kiểm chữ ký trước khi parse JSON.

## Router

`Bot` (TS/Python) hoặc `Router` (Go) bọc client và nhận update từ poll hay webhook như nhau:

- `command(name, handler)`: tin nhắn có entity `bot_command` ở offset 0; `/name@username` chỉ khớp khi `username` là của bot (lấy bằng `getMe` một lần khi chạy); `args` là phần sau lệnh, đã bỏ khoảng trắng đầu cuối.
- `callback(prefix, handler)`: `callback.data` bắt đầu bằng prefix; prefix dài hơn thắng.
- `inlineQuery(handler)`, `message(handler)` (mọi tin không khớp lệnh nào), `on(kind, handler)` cho kind khác (`message_edited`, `channel_post`, `member_changed`, `reaction`).
- Context truyền vào handler: `update`, `client`, và tiện ích `reply(text, options)` (gửi vào chat của tin hoặc của tin có nút), `answer(text?, showAlert?)` (callback), `answerInline(results, options)` (inline).
- Kind không biết thì bỏ qua (forward compatible).

## Bot mẫu (dùng cho conformance)

Mỗi SDK có `examples/` với 6 bot, cùng hành vi y hệt; chạy bằng biến môi trường: `BOT_TOKEN`, `BOT_API` (base URL), `BOT_MODE` = `poll` (mặc định) hoặc `webhook`; ở `webhook`: `WEBHOOK_PORT`, `WEBHOOK_SECRET`, `WEBHOOK_URL` (URL công khai, bot tự `setWebhook` với URL + secret khi khởi động; `poll` thì gọi `deleteWebhook` trước). In đúng một dòng `ready` ra stdout khi đã sẵn sàng nhận update.

| Bot | Hành vi |
|---|---|
| `echo` | Tin chữ không phải lệnh → trả lời đúng chữ đó. `/start` → `Xin chào! Gửi gì mình nhắc lại nấy.` |
| `keyboard` | `/start` → tin `Chọn một:` với bàn phím inline một hàng: `A` (`pick:a`), `B` (`pick:b`). Bấm nút → `answerCallback` với `Đã chọn A` (hoặc B) và sửa tin đó thành `Bạn chọn A` (bỏ bàn phím). |
| `files` | `/file` → gửi document tải lên `hello.txt`, nội dung `xin chào` (UTF-8, 9 byte), chú thích `Tệp mẫu`. Tin có `media` → `getFile`, tải về, trả lời `Nhận <file_name hoặc kind>: <số byte tải được> byte`. |
| `commands` | Khi khởi động `setCommands` với `start` (`Bắt đầu`) và `help` (`Trợ giúp`). `/help` → `Lệnh: /start, /help`. `/start` → `Sẵn sàng.` |
| `inline` | `inline_query` → `answerInlineQuery` một kết quả article id `1`, tiêu đề = query viết hoa, nội dung = query, `cache_time` 1 (0 nghĩa là mặc định 300); query rỗng thì không có kết quả. |
| `miniapp` | `/start` → tin có nút inline `Mở cửa hàng` mở `MINI_APP_URL` (`web_app`). Server nhỏ ở `MINI_APP_PORT`: `POST /verify` (body là init data) kiểm bằng helper SDK với id bot từ `getMe` và khoá `getMiniAppKey` (cache, lấy lại một lần khi sai) → 200 `{user_id, chat_type}` hoặc 401. Tin có `web_app_data` → trả `Đã nhận đơn: <data>`. Python cần extra `cryptography`. |

## Chất lượng

- Docstring/JSDoc/Go doc cho mọi API công khai; README ngắn trong mỗi thư mục SDK (cài, bắt đầu nhanh, webhook, chạy test).
- Unit test runtime bằng server HTTP giả trong tiến trình: envelope và `ApiError`, thử lại 429/503, multipart đúng tên part, `verifyWebhook` (đúng, sai secret, sai chữ ký, lệch giờ), handler webhook (401, 204, answer, trùng id), poll (offset, 409 dừng), router (lệnh có `@username`, prefix callback, inline).
- Không thêm dependency runtime nào.
