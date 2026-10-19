# Phase 1: feedback signals (fullstack-developer, 2026-10-19)

Status: DONE. Nothing is committed; the controller commits and deploys.

## What shipped
- **Settings › Góp ý.** A row in the Settings nav (avatar › Cài đặt › Góp ý, two clicks) opens a lazy dialog. It offers Góp ý or Báo lỗi, takes up to 2000 characters and shows the toast "Đã gửi góp ý. Cảm ơn bạn!". It calls `FeedbackService.SendFeedback` (new `proto/app/v1/feedback.proto`). The item is stored in `feedback` with `chat_id` 0 and `seq = -id`, so no schema change and the old binary still reads it. The rate limit is 5 in a row, then 1 per minute. `Feedback.source` (SETTINGS/ASSISTANT) shows as "qua Cài đặt"/"qua Trợ lý" in Kiểm duyệt › Góp ý. That screen's header, empty-state and reply-hint copy were updated (vi and en). Replies to Settings feedback go out through Trợ lý as a new message that quotes the item.
- **Instant notices.** New feedback (from Settings or the bot) and new reports are posted into "Vận hành chat" (`watch.Group`, which the watchdog now shares, and `hooks.PostNative`). A notice holds the kind, Name (@username), source and a 140-character excerpt with emails and phone numbers masked. Report notices carry only the reason and the target kind. Each notice has a button to the moderation page. Without operators the notice is skipped and logged at Info.
- **Daily digest at 08:00 Asia/Saigon** (`watch.Digest`). It covers the previous day: new users, senders, messages, new and open feedback, new reports, and client errors (total plus the top 3). The `ops_digests` marker plus a hook idempotency key stop double posts. A missed day is posted once, with no backlog. All counts read indexes by date; messages use the snowflake id range (`ids.SnowflakeFloor`).
- **Client JS errors.** `src/error-reporter.ts` adds +0.6 KB gz to startup. It reports window `error` and `unhandledrejection` events, plus React render errors through `onUncaughtError`. Each page load sends at most 5 reports, each fingerprint once. A report carries only the message with URLs cut, our own top frame, the release and the route name. `ReportClientError` also accepts signed-out callers. It is rate limited per user or IP, scrubbed with `redact` plus URL, phone and number masks, and counted per day in `client_errors` (at most 500 kinds per day, kept 90 days).
- Migration `0029_feedback_signals.sql` is expand-only.
- Mocks were updated first: `settings.html#feedback` and `moderation.html#feedback`.
- Docs: `docs/deployment-guide.md`, `server/README.md` and `docs/privacy/data-inventory.md`.
- No new env var and no nginx change.

## Verification
- gofmt clean; `go vet ./...` OK; `go test -race -p 2 ./...` passes in all packages, 0 FAIL.
- New Go tests: api `TestFeedbackAndReportsReachOperators`, `TestFeedbackWithoutOperatorsGroup`, `TestClientErrorReports` and `TestDailyDigest`; assistant `TestReplyToFeedbackFromSettings`; watch `TestDueDay`, `TestNoticeEntities` and `TestFeedbackNoticeScrubsContacts`; ids `TestSnowflakeFloor`.
- Web: `tsc --noEmit` OK; `pnpm -s lint` OK; vitest (2 workers) 48 files / 441 tests pass, including the new `test/feedback.test.tsx` and the extended moderation feedback test; core 26 files / 786 tests pass; `pnpm -s typecheck` OK.
- `pnpm -s perf`: startup JS 143.1 KB of a 150 KB budget (was 142.5 KB); CSS 18.0 of 20 KB; all budgets met.
- `pnpm -s e2e` (full run): 31/31 pass.
- `proto:lint` and `proto:breaking` pass; `proto:gen` regenerates identical files.

## Notes
- The digest also runs right after a deploy. If no digest was ever posted, it posts yesterday's once.
- The message count excludes service messages and recalled ones. It counts messages with text or a file.
- `docs/acceptance.md` (untracked) is not from this phase; I left it alone.
