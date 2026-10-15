# R5: official welcome bot (Trợ lý) and feedback queue

Status: DONE. Nothing committed or pushed; production untouched.

## What shipped

- **Assistant bot.** There is one system bot per tenant, `tro_ly_bot`, named `<shortName> Trợ lý` (the shortName comes from the brand config). It lives in `bots.is_system`, with one per tenant enforced by a unique index. The bot owns itself (`owner_id` is its own id), so it never counts toward anyone's 20-bot limit, and ListMyBots, Update and Delete never see it. It has no token. Its tier is `internal` and it is verified. Nobody can add it to a group. Its row holds the username, so no one else can take it.
- **Startup.** `-role api` runs `botadmin.EnsureSystemBot` under a tenant advisory lock. It creates the bot on first start and refreshes the name, description, about text and commands on later starts.
- **The chat.** On every app start, `GetSelf` calls `chat.EnsureSystemBotChat`. The first time, it creates an empty private chat with the bot and sends one `member_added` update, so every open session sees the chat at once. No message is sent. If a user deletes the chat, it is not recreated. Existing users get the chat on their next start.
- **Client change.** `member_added` for yourself now also refreshes the dialog from the server, so an empty chat gets its correct place in the list. Clicking "Bắt đầu" uses the existing UI, so consent works as for any bot.
- **Runtime.** The bot runs in process (`internal/assistant`). It reads updates with `botupdates.Poll`, the same long poll behind `/bot/v1/updates`. It sends through `botapi.SendAsSystemBot` and `AnswerAsSystemBot`, which use the same checks, tier rate limits and `SendBotMessage` path as HTTP; they refuse any bot that is not a system bot.
- **Idempotent effects.** Each update has a derived `random_id`, and feedback is keyed by its message `(chat_id, seq)`. A failing update is retried 3 times, then skipped and logged.
- **Bot behaviour.**
  - `/start` sends the welcome with 4 tips (Cloud của tôi, tạo nhóm và mời, tìm không dấu, Developer Console) and three inline buttons: "Hướng dẫn nhanh", "Gửi góp ý", "Báo lỗi".
  - `/huongdan` and the guide button send the quick guide.
  - "Gửi góp ý", "Báo lỗi" and a bare `/gopy` ask for the text and label the next message as an idea or a bug (kept in memory for 1 hour). `/gopy <text>` records the text at once.
  - Any other plain text is recorded as an idea. The bot answers "Cảm ơn bạn! Đội ngũ đã nhận được góp ý." as a reply to that message.
  - Unknown commands get a hint to use `/huongdan`. Messages with no text are asked to resend as text.
- **Feedback queue.** Feedback is stored in the `feedback` table. `ModerationService` gets three new RPCs:
  - `GetFeedback` lists open or handled items, with a cursor and the senders.
  - `ResolveFeedback` marks an item handled.
  - `ReplyFeedback` sends the answer through the bot as a reply to the user's message, prefixed "Phản hồi từ đội ngũ <appName>:", then closes the item. It refuses a second answer (`already_replied`) and a user who blocked the bot (`user_unreachable`).
- **Web, mock first.**
  - `moderation.html#feedback` has the new section.
  - `chat.html#first-run` now shows the assistant row below Cloud của tôi.
  - The app adds a "Góp ý" link in the Moderation sidebar and a `/moderation/feedback` route. That page has "Chưa xử lý" and "Đã xử lý" tabs, items with the sender, kind, time and full text, plus "Trả lời" (a dialog) and "Đã xử lý".
  - Narrow screens get a "Hàng đợi báo cáo · Góp ý" tab bar, because the sidebar is hidden there.
  - The team-invite card still shows when the list holds only Cloud của tôi and bots.
- **Brand.** `server/internal/brand/brand.json` is written by `pnpm brand:gen`. A Go test and a vitest test fail if it drifts from `brand.config.json`, and `check-brand` passes.
- **Docs.**
  - `server/README.md` has a new section, "Bot chính thức (Trợ lý)", plus notes in the moderation and background-jobs paragraphs.
  - `docs/deployment-guide.md` has the release notes and a "Bot chính thức (Trợ lý)" lookup section.
  - Phase 8's todo is ticked, and the announce feature is split into its own open item.

## Gates (evidence)

- `gofmt -l`: empty. `go vet ./...`: clean. `golangci-lint run ./...`: `0 issues.`
- `go test -race -count=1 -p 2 ./...`: 29 packages ok, 0 failures.
- New Go tests:
  - `internal/assistant`: the full journey (start, buttons, idea and bug, commands, operator answer, second answer refused, non-operator denied) and idempotent Ensure.
  - `internal/botadmin/system_test.go`: the bot can't be managed or authenticated, the owner limit is unaffected, a held username is refused.
  - `internal/chat/assistant_test.go`: 4 concurrent ensures create one chat with one update, deleted chats stay deleted, bots get no chat, feedback paging and validation.
  - `internal/api/assistant_test.go`: wiring through `GetSelf` and the RPCs.
- `pnpm lint` (eslint plus brand check): clean. `pnpm typecheck`: clean.
- vitest (`--maxWorkers=2`): brand 12/12, core 765/765, platform-web 17/17, web 331/331. A new core test fails without the `apply.ts` change and passes with it. New web tests cover the feedback screen and the route.
- `pnpm perf`: all budgets met. Startup JS is 146.5 KB gzip (budget 150; it was about 146.3). Startup CSS is 17.0 KB (budget 20).
- `pnpm e2e`: 22/22 pass, including the new `assistant.e2e.ts`. In it, Giang (new) sees the assistant under Cloud, presses Bắt đầu, gets the greeting with three buttons, presses Gửi góp ý, sends feedback and gets thanked. Chi (operator) opens Kiểm duyệt > Góp ý, replies, sees the item under Đã xử lý, and Giang receives the answer.
- Proto: `buf lint` and `buf breaking` against main are clean (additive only), and `proto:gen` shows no drift.
- gitleaks on the full working diff: no leaks found.
- Screenshots: 22 PNGs (1.6 MB) at 1333×780 and 390×844, covering the app and the mock. `document.scrollWidth` equals the viewport width in every shot, and no element scrolls horizontally. They are in `plans/dattqh/reports/fullstack-developer-261015-2018-welcome-bot-shots/`.

## Deploy notes

- **Migration:** `0016_system_bot_feedback`, expand-only. It adds `bots.is_system` with a partial unique index, and the `feedback` table. The previous binary runs fine on the new schema.
- **Environment:** no new variables. Operators must already be in `CHAT_OPERATOR_USER_IDS` to see Góp ý; without it, feedback is still stored.
- **Root deploy:** not needed. There are no nginx, script or DNS changes, so the normal automatic deploy works.
- **After deploy:** look for the log line `assistant bot ready`. If you see the Error `assistant bot is off: another account holds its username`, an account already owns `tro_ly_bot`; rename it and reload.
- **Rollback:** the chat stays (it is just a bot chat); pressing Start gets no answer until this release is back; stored feedback is kept.

## Deviations and decisions

- I added a Giang account to the e2e stack and made Chi an operator: the stack now creates Chi's account before the api starts so her id can go into `CHAT_OPERATOR_USER_IDS`.
- I changed two existing api tests that assumed the user has nothing but Cloud của tôi:
  - The realtime helper now skips update frames that arrive before Hello. An update committed before the socket was dialled can legitimately come first, because the socket is registered before Hello is written.
  - The search test now uses a chat id that is definitely foreign, instead of `saved+1`.
- The moderation UI wording says "bot Trợ lý" without the brand name, so the web needs no copy of the server's naming rule.

## Concerns

- The 22 screenshots (1.6 MB) are in the reports folder; whether to commit them is your call, as before.
- The idea/bug label after pressing a button is kept in memory. A restart within that hour files the next message as an idea rather than a bug; the text is never lost.
- Announcements of new features were not in scope and are still open in Phase 8.
