# @achoo254/chat-bot-sdk

TypeScript (Node) SDK of the Bot API of the [chat-next](https://github.com/achoo254/chat-next) server, for Node
≥ 22: a typed client (generated from
[`spec/bot-api/openapi.yaml`](https://github.com/achoo254/chat-next/blob/main/spec/bot-api/openapi.yaml)) that
retries `429`/`503`, file uploads and downloads, long poll, webhook signature checks, Mini App init data
verification and a router. It uses only the built-in `fetch`, `node:http` and `node:crypto`; no runtime
dependencies.

There is no default server: `baseUrl` is required and is the Bot API URL of **your** chat server
(`<CHAT_PUBLIC_URL>/bot/v1`). `new Client(token, {})` throws a `TypeError` that says so.

The API is `0.x`: it may change in any minor release until 1.0. Pin the exact version.

## Install

```sh
npm install @achoo254/chat-bot-sdk
```

The package is not on npm yet: the publishing account is suspended. Until it is published, build the
tarball from a checkout of this repository and install that file:

```sh
git clone https://github.com/achoo254/chat-next.git && cd chat-next
pnpm install
pnpm --filter @achoo254/chat-bot-sdk build
pnpm --filter @achoo254/chat-bot-sdk pack --pack-destination /tmp
# then, in your project:
npm install /tmp/achoo254-chat-bot-sdk-<version>.tgz
```

## Quick start

```ts
import { Bot, Client } from "@achoo254/chat-bot-sdk";

const client = new Client(process.env.BOT_TOKEN ?? "", { baseUrl: "https://chat.example.com/bot/v1" });
console.log(await client.getMe());

const bot = new Bot(client);
bot.command("start", (ctx) => ctx.reply("Hello!"));
bot.callback("pick:", (ctx) => ctx.answer(`Picked ${ctx.callback?.data}`));
bot.message((ctx) => ctx.reply(ctx.message?.text ?? ""));

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
await bot.client.deleteWebhook();
await bot.poll({ signal: stop.signal });
```

A bot and its token come from the chat app's developer console (`BotAdminService`): create the bot, then
issue its token (shown once; it needs a recent sign-in).

- `Client` has every API method (`sendMessage`, `editMessage`, `getFile`, ...), plus `sendMediaUpload`,
  `sendAlbumUpload` (multipart; a file is `new InputFile(name, Blob | Uint8Array)`), `downloadFile(file)` and
  `request()` for methods newer than the SDK.
- API errors are `ApiError` (`status`, `code`, `description`, `retryAfter`): branch on `code`. No HTTP answer
  is a `NetworkError`.
- Automatic retries only for `429 rate_limited` and `503 unavailable` (after `retry_after`, else 1 s; 3 times by
  default), and for connection failures of a `GET`. The token is only ever sent in the `Authorization` header.
- Router: `command(name)` matches `/name` and `/name@bot_username`; `callback(prefix)` picks the longest
  prefix; `inlineQuery`, `message` (messages no command matched), `on(kind)` for `message_edited`,
  `channel_post`, `member_changed`, `reaction`. Unknown kinds are ignored.

## Webhook

```ts
import { createServer } from "node:http";

createServer(bot.webhookHandler(process.env.WEBHOOK_SECRET ?? "")).listen(8443);
await bot.init();
await bot.client.setWebhook({ url: "https://bot.example.com/hook", secret: process.env.WEBHOOK_SECRET ?? "" });
```

The handler checks `X-Bot-Api-Secret-Token` and the HMAC signature before parsing JSON (`401` when wrong),
refuses bodies over 1 MiB (`413`), drops the last 1000 duplicate `update_id`s (`200`), and answers `204`, or `200`
with JSON when the handler returns a `WebhookAnswer` (e.g. `{ method: "sendMessage", chat_id, text }`); a
handler that throws gets `500`, so the server retries. Without the router: `webhookHandler({ secret, onUpdate })`
and the pure `verifyWebhook(headers, rawBody, secret, now?)`.

## Mini App

`verifyMiniAppInitData(initData, botId, publicKey, maxAgeS?, now?)` checks the Ed25519 signature of a Mini App's
init data (key from `client.getMiniAppKey()`), its `bot_id` and the age of `auth_date` (1 hour by default); it
returns the checked fields, or `null`.

## Server requirements

A running [chat-next server](https://github.com/achoo254/chat-next/tree/main/server) (Go, PostgreSQL 16, an
OpenID Connect provider); see [`server/README.md`](https://github.com/achoo254/chat-next/blob/main/server/README.md)
for its environment and how to run it. The Bot API answers only on the host of the server's `CHAT_PUBLIC_URL`,
so a reverse proxy in front of it must keep the `Host` header. Full API reference:
[`docs/bot-api/README.md`](https://github.com/achoo254/chat-next/blob/main/docs/bot-api/README.md).

## Example bots

`examples/` in the repository holds 6 bots (`echo`, `keyboard`, `files`, `commands`, `inline`, `miniapp`) used for
conformance, run with Node ≥ 22.18:

```sh
BOT_TOKEN=... BOT_API=https://chat.example.com/bot/v1 node examples/echo.ts
# webhook: BOT_MODE=webhook WEBHOOK_PORT=8443 WEBHOOK_SECRET=... WEBHOOK_URL=https://bot.example.com/hook
```

Each bot prints exactly one `ready` line to stdout once it receives updates; other logs go to stderr.
`src/generated.ts` is generated (`cd server && go run ./cmd/sdkgen`); do not edit it by hand. Tests:
`pnpm --filter @achoo254/chat-bot-sdk test`.

## License

MIT, see `LICENSE`.
