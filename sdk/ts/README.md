# @app/sdk — Bot API SDK cho TypeScript (Node)

SDK chính thức của [Bot API](../../docs/bot-api/README.md) cho Node ≥ 22: client có kiểu (sinh từ [`spec/bot-api/openapi.yaml`](../../spec/bot-api/openapi.yaml)), tự thử lại `429`/`503`, tải file lên/xuống, long poll, kiểm chữ ký webhook và router. Chỉ dùng `fetch`, `node:http`, `node:crypto` có sẵn; không có dependency runtime.

`src/generated.ts` là mã sinh, không sửa tay. Sinh lại: `cd server && go run ./cmd/sdkgen`.

## Cài

SDK chưa lên registry; cài từ repo:

```sh
# trong monorepo này (pnpm workspace)
pnpm add @app/sdk --workspace
# dự án khác: trỏ tới thư mục sdk/ts của bản checkout
npm install /đường/dẫn/chat-next/sdk/ts
```

Gói xuất thẳng mã nguồn TypeScript (`src/index.ts`): Node ≥ 22.18 chạy được không cần build (type stripping); dự án có bundler hoặc `tsc` thì dùng như mọi gói TS.

## Bắt đầu nhanh

```ts
import { Bot, Client } from "@app/sdk";

const bot = new Bot(new Client(process.env.BOT_TOKEN ?? "", { baseUrl: "https://chat.hoandat.com/bot/v1" }));

bot.command("start", (ctx) => ctx.reply("Xin chào!"));
bot.callback("pick:", (ctx) => ctx.answer(`Đã chọn ${ctx.callback?.data}`));
bot.message((ctx) => ctx.reply(ctx.message?.text ?? ""));

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
await bot.client.deleteWebhook();
await bot.poll({ signal: stop.signal });
```

- `Client` có đủ method của API (`sendMessage`, `editMessage`, `getFile`, …), thêm `sendMediaUpload`, `sendAlbumUpload` (multipart, file là `new InputFile(tên, Blob | Uint8Array)`), `downloadFile(file)` và `request()` cho method mới hơn SDK.
- Lỗi API là `ApiError` (`status`, `code`, `description`, `retryAfter`): rẽ nhánh theo `code`. Không có câu trả lời HTTP thì là `NetworkError`.
- Thử lại tự động chỉ với `429 rate_limited` và `503 unavailable` (chờ `retry_after`, không có thì 1 s; mặc định 3 lần), và lỗi mạng của `GET`.
- Router: `command(name)` khớp `/name` và `/name@username_của_bot`; `callback(prefix)` chọn prefix dài nhất; `inlineQuery`, `message` (tin không khớp lệnh nào), `on(kind)` cho `message_edited`, `channel_post`, `member_changed`, `reaction`. Kind lạ bị bỏ qua.

## Webhook

```ts
import { createServer } from "node:http";

createServer(bot.webhookHandler(process.env.WEBHOOK_SECRET ?? "")).listen(8443);
await bot.init();
await bot.client.setWebhook({ url: "https://bot.example.com/hook", secret: process.env.WEBHOOK_SECRET ?? "" });
```

Handler kiểm `X-Bot-Api-Secret-Token` và chữ ký HMAC trước khi đọc JSON (sai → `401`), từ chối body > 1 MiB (`413`), bỏ trùng 1000 `update_id` gần nhất (`200`), trả `204`, hoặc `200` kèm JSON khi handler trả một `WebhookAnswer` (ví dụ `{ method: "sendMessage", chat_id, text }`); handler lỗi → `500` để server gửi lại. Không dùng router thì có `webhookHandler({ secret, onUpdate })` và hàm thuần `verifyWebhook(headers, rawBody, secret, now?)`.

## Mini App

`verifyMiniAppInitData(initData, botId, publicKey, maxAgeS?, now?)` kiểm chữ ký Ed25519 của dữ liệu khởi tạo Mini App (khoá từ `client.getMiniAppKey()`), `bot_id` và tuổi `auth_date` (mặc định tối đa 1 giờ); trả các trường đã kiểm, hoặc `null`. Xem [Bot API, mục Mini App](../../docs/bot-api/README.md#11-mini-app).

## Bot mẫu

`examples/` có 6 bot (`echo`, `keyboard`, `files`, `commands`, `inline`, `miniapp`) dùng cho conformance; chạy bằng Node ≥ 22.18. `miniapp` gửi nút mở Mini App (`MINI_APP_URL`, https trên domain của bạn) và chạy backend của Mini App ở `MINI_APP_PORT` (mặc định 8081): `POST /verify` nhận nguyên chuỗi init data, trả `{"user_id", "chat_type"}` hoặc `401`.

```sh
BOT_TOKEN=... BOT_API=https://chat.hoandat.com/bot/v1 node examples/echo.ts
# webhook: BOT_MODE=webhook WEBHOOK_PORT=8443 WEBHOOK_SECRET=... WEBHOOK_URL=https://bot.example.com/hook
```

Bot in đúng một dòng `ready` ra stdout khi sẵn sàng; log khác ra stderr.

## Test

```sh
pnpm --filter @app/sdk test     # vitest, server HTTP giả trong tiến trình
npx tsc --noEmit -p sdk/ts      # từ gốc repo
```
