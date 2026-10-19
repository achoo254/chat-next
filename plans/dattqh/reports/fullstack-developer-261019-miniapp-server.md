# R6 Mini Apps: server and SDKs (2026-10-19)

Status: done. Contract: `phase-16-mini-app.md`, section "Hợp đồng R6 web". Nothing is committed; the changes are in the working tree.

## What changed

- **Migration** `server/migrations/0028_bot_mini_app.sql`: adds `bots.mini_app_url text NOT NULL DEFAULT ''`. It is expand-only and sets `lock_timeout`.
- **`internal/miniapp`** (new package):
  - `URLs.Check` refuses a URL that is not https, carries user:pass or a fragment, has an IP host (including the WHATWG numeric forms `127.1` and `0x7f.1`), is a single label or a public suffix, or is longer than 512 bytes. It also refuses a host on or under the registrable domain of `PublicURL`, or on or under any domain in the `tenants` table. Refusals are `invalid_argument` with the prefix `mini_app_url_not_allowed:`.
  - `Signer` derives an Ed25519 key with HKDF-SHA256 from `SESSION_KEY` (info `chat-miniapp-ed25519`) and a separate `chat_instance` HMAC key (info `chat-miniapp-chat-instance`). Both stay in memory only. `Sign` produces exactly the contract's query string. `start_param` is left out when empty. `chat_instance` is base64url of a 12-byte HMAC of the chat and bot (for the profile: the user and bot).
- **Developer Console**: `UpdateBot` validates `mini_app_url`, and `""` removes it. `Bot.mini_app_url` and `GetBotInfoResponse.mini_app_url` are now filled. `botadmin.New` takes a `*miniapp.URLs`.
- **Chat core** (`chat/miniapp.go`):
  - `MiniAppChatType` checks where the app opens. From the profile it gives `sender` (main app only). The main app in a chat needs the caller and the bot to be current members. A button URL must belong to the bot's own message, which the caller can see.
  - `AllowBotWrite` applies the write rate limit, records consent with source `button` and opens the private chat. No message is sent.
  - `SendMiniAppData` checks the data (1 to 4096 bytes of UTF-8) and the button text, applies the send limit, then posts `ActionMiniAppData` through the normal `postText` path, so outbox, realtime and bot updates all work.
  - Bot keyboards now accept `InlineButton.mini_app_url` (checked with `URLs.Check`). Inline results still allow URL buttons only.
- **RPC**: `OpenMiniApp` re-checks the URL when it opens, signs the init data and validates `start_param`. `AllowMiniAppWrite` and `SendMiniAppData` are implemented.
- **Bot API**:
  - Buttons accept `web_app: {url}`, which maps to `mini_app_url`.
  - A message carrying `ActionMiniAppData` reaches the bot as `message.web_app_data {data, button_text}`, with no `action`.
  - New `GET /bot/v1/miniAppKey` returns `{"public_key"}`.
  - The OpenAPI spec is now version 1.3.0 and the SDKs were regenerated.
- **SDK helpers**:
  - TS: `verifyMiniAppInitData` in `sdk/ts/src/mini-app.ts`, using `node:crypto`.
  - Go: `VerifyMiniAppInitData` in `sdk/go/miniapp.go`, using `crypto/ed25519`.
  - Python: `verify_mini_app_init_data` in `sdk/python/chatbot/miniapp.py`. The standard library has no Ed25519 and the repo has no pure-Python version, so it uses `cryptography` as an optional extra `[miniapp]`, imported lazily with a clear `RuntimeError`.
  - All three check the same test vector, which the Go test `TestSignVector` pins and which is also published in the docs.
- **Docs**: `docs/bot-api/README.md` has a new section 11 on Mini Apps with the test vector. The SDK READMEs were updated.

## Verification

| Check | Result |
|---|---|
| `gofmt -l .` (server) | 0 files |
| `go vet ./...` (server) | exit 0 |
| `go test -race -p 2 -count=1` on miniapp, chat, botadmin, botapi/..., rpc, assistant, botupdates, hooks, cmd/sdkgen | all ok |
| `go test -race -p 2 -count=1 ./internal/api/` | ok (35 s) |
| sdk/go `go vet`, `go test -race ./...` | ok |
| sdk/ts `tsc --noEmit`, `vitest run` (5 files, 50 tests), eslint on the new files | ok |
| sdk/python unittest (68 tests) | ok; the 2 Ed25519 tests are skipped without `cryptography`. In a scratch venv with `cryptography` they pass. |

Not run: the opt-in `SDK_CONFORMANCE=1` suite (3 SDKs × examples). The generated code is covered by the typecheck and unit tests above.

## Open points

- **Tenant domains.** The only tenant domains known in-process are the rows of `tenants`. The IdP looks tenants up by host and has no list API. A tenant that enables chat later would make a stored URL invalid, and `OpenMiniApp` re-checks the URL, so such a URL stops opening. This limitation is documented in `URLs.Check`.
- **Where `SendMiniAppData` was opened from.** The server keeps no state of opened Mini Apps, so it cannot enforce "only from the private chat or profile". The client must enforce it. The message only ever goes into the caller's own chat with the bot.
- **Sending by user id.** The Bot API has no "send to user id" method. After `AllowMiniAppWrite`, a bot reaches the user through the private chat (bulk sends by `user_ids` work) or a chat id its backend already knows.
- **Phase checklist.** I did not change the phase-16 Todo checkboxes. Plan status belongs to the orchestrator.
