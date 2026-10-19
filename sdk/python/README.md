# chat-bot-sdk (Python)

Python SDK of the chat platform's Bot API. Python 3.11 or newer, standard library only (verifying Mini App
init data needs the optional `cryptography` package, see below).
Types and API methods are generated from [`spec/bot-api/openapi.yaml`](../../spec/bot-api/openapi.yaml)
into `chatbot/_generated.py` (do not edit; regenerate with `cd server && go run ./cmd/sdkgen`).
API guide: [`docs/bot-api/README.md`](../../docs/bot-api/README.md).

## Install

```sh
pip install ./sdk/python            # from a checkout of the monorepo
# or from a git tag:
pip install "chat-bot-sdk @ git+<repo-url>@<tag>#subdirectory=sdk/python"
```

The import package is `chatbot`.

## Quick start (long poll)

```python
import os
from chatbot import Bot, Client, Context

bot = Bot(Client(os.environ["BOT_TOKEN"]))  # base_url defaults to https://chat.hoandat.com/bot/v1

@bot.command("start")
def start(ctx: Context) -> None:
    ctx.reply("Xin chào!")

@bot.message
def echo(ctx: Context) -> None:
    if ctx.message and ctx.command is None and ctx.message.get("text"):
        ctx.reply(ctx.message["text"])

bot.client.delete_webhook()  # a webhook makes every poll answer 409
bot.run_polling()
```

- `Client(token, base_url=..., timeout=60, retries=3)` has every API method as snake_case
  keyword methods (`send_message`, `edit_message`, `get_updates`, …) returning TypedDicts.
  Errors raise `ApiError` with `status`, `code`, `description` and `retry_after`; branch on
  `code`. `429 rate_limited` and `503 unavailable` are retried after `retry_after` (or 1 s);
  a network error raises `NetworkError` and is retried for `GET` only.
- Uploads: `client.send_media_upload(chat_id=42, kind="document", file=InputFile("a.txt", b"..."))`
  and `client.send_album_upload(chat_id=42, items=[{"attach": "a", "kind": "photo"}, ...],
  files={"a": InputFile("a.jpg", open("a.jpg", "rb")), ...})`. Downloads:
  `client.download_file(client.get_file(file_id))` returns the bytes.
- Router: `bot.command(name)`, `bot.callback(prefix)` (longest prefix wins), `bot.inline_query`,
  `bot.message` (messages no command matched) and `bot.on(kind)` for other kinds, as decorators
  or `bot.command("start", handler)`. A handler gets a `Context` with `update`, `client`,
  `message`, `callback`, `inline_query`, `command`, `args` and `reply(...)`, `answer(...)`,
  `answer_inline(...)`. `/name@username` only matches this bot's username (read once with `get_me`).
- `run_polling(client, handler, stop=event)` / `bot.run_polling(stop=event)` returns when the
  `threading.Event` is set; `409 conflict` and other non-retryable errors are raised.

## Webhook

```python
bot.client.set_webhook(url="https://bot.example.com/hook", secret=SECRET)
bot.serve_webhook(secret=SECRET, port=8080)        # http.server, one thread per request
# or mount the WSGI app in any WSGI server:
application = bot.wsgi_app(SECRET)
```

The app checks `X-Bot-Api-Secret-Token`, `X-Bot-Signature` and `X-Bot-Timestamp`
(`verify_webhook(headers, raw_body, secret)`) before parsing, answers `401` when they do not match,
`413` above 1 MiB, `200` without running the handler again for an `update_id` seen recently,
`200` with the handler's `WebhookAnswer` as JSON, `204` when it returns `None`, and `500` when it
raises (the server delivers again). Serve it behind HTTPS; the server only calls `https` URLs.

## Mini Apps

`verify_mini_app_init_data(init_data, bot_id, public_key, max_age=3600, now=None)` checks the Ed25519
signature of a Mini App's init data (key from `client.get_mini_app_key()`), its `bot_id` and the age of
`auth_date`, and returns the verified fields or `None`. Ed25519 is not in the standard library, so it needs
`cryptography`: `pip install './sdk/python[miniapp]'`; without it the call raises `RuntimeError`. See the
[Bot API guide](../../docs/bot-api/README.md#11-mini-app).

## Examples

`examples/` holds `echo`, `keyboard`, `files`, `commands`, `inline` and `miniapp`. Run them from this
directory without installing. `miniapp` sends a button that opens the Mini App at `MINI_APP_URL` (https,
on your own domain) and serves the Mini App's backend on `MINI_APP_PORT` (default 8081): `POST /verify`
takes the raw init data and answers `{"user_id", "chat_type"}` or `401`. It needs the `miniapp` extra
(`cryptography`); the SDK conformance suite runs it with `PYTHON` set to an interpreter that has it.

```sh
BOT_TOKEN=... BOT_API=https://chat.hoandat.com/bot/v1 python3 examples/echo.py
BOT_MODE=webhook WEBHOOK_PORT=8080 WEBHOOK_SECRET=... WEBHOOK_URL=https://bot.example.com/hook \
  BOT_TOKEN=... python3 examples/echo.py
```

Each prints one line `ready` on stdout when it can receive updates; logs go to stderr.

## Tests

```sh
cd sdk/python && python3 -m unittest discover -s tests -v
```

The tests run against an in-process fake of the API and start the examples as child processes.
