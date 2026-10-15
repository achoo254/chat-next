# Webhook and service worker hardening (review 261015-1909 + live Console review)

Date: 2026-10-15. Source: `code-reviewer-261015-1909-webhook-sw.md` and the controller's list of Jev's decisions. Not committed, not deployed.

## Deploy facts for the controller

- **Root deploy needed: YES.** `infra/chat/nginx/chat.hoandat.com.conf` gains `location = /sw.js`, and `infra/chat/sw-kill-switch.js` is new. Automatic deploys only use the conf in `/opt/chat/infra/nginx`.
- **Env var to set on prod: YES.** Add `OUTBOUND_DENY_CIDRS=103.72.98.65` to `/opt/chat/.env` before the deploy. `activate-release.sh` reloads pm2 with `--update-env`.
  - If it is missing, the server still starts. It still refuses the public addresses on the host's network interfaces.
  - After the deploy, check that the startup log line `outbound requests refuse these ranges` lists `103.72.98.65/32`.
  - When the variable is set, update `docs/infrastructure-inventory.md`: move `OUTBOUND_DENY_CIDRS` from "Chưa đặt" into the list of variables that are set.
- No migration, DNS or certificate change.

## Delivered

| Item | Change |
|---|---|
| H1 | `SetBotWebhook` needs an IdP sign-in within the last 10 minutes. It uses the new `botadmin.OwnedRecent`, which wraps `requireRecentSignIn` and returns the same `reauth_required`. `PUT /bot/v1/webhook` with the bot token is unchanged. Console flow: on `reauth_required` the form (URL, secret, kinds, max, drop) is kept in this tab's `sessionStorage` (validated on read, dropped after 15 minutes, removed once read). The reauth dialog then links to `/auth/login?reauth=1&return_to=…/updates?after=webhook`. Back on the page, a "Lưu webhook?" dialog shows the URL and saves only from its own button. A link that carries `?after=webhook` with no kept draft opens nothing. |
| M2 | `safehttp.Options.Deny` blocks ranges even in development, and IPv4-mapped addresses are matched by their IPv4 form. `OUTBOUND_DENY_CIDRS` (IPs or CIDRs, at most 100) is added together with `safehttp.HostAddresses()` (the public addresses on the host's interfaces). The same list also applies to link previews. |
| M4 | `location = /sw.js` serves `/opt/chat/sw-override/sw.js`, else `current/web/sw.js`, else `404` (never `index.html`), with `no-cache` and the same CSP. `infra/chat/sw-kill-switch.js` calls `skipWaiting`, deletes the `app-shell-*` caches and unregisters itself. It has no fetch handler. The deployment guide's rollback paragraph is corrected, and a new section "Service worker: kill switch" covers enabling, checking and disabling it, plus the case of a pre-SW release. |
| M1 | `replyMax` is 64 KiB. A new `slots` limits the process to 256 webhook requests in flight, shared fairly. A bot gets a slot only while it holds less than max / (bots holding or waiting). Freed slots wake as many waiting bots as there are free slots, the bots holding the fewest first. |
| M3 | An idle worker only reads the database when one of these happens: new updates are stored, its webhook changes, a request ends, a slot frees, or a retry falls due. A safety recheck runs once a minute; it was every 2 s. `rescan` wakes workers of bots that no longer have a webhook. `heads` is now a recursive skip scan on `bot_updates_pending_idx`. Under `EXPLAIN ANALYZE` in a test with 30,000 pending updates in 3 chats, it reads 7 rows of `bot_updates`, with no Seq Scan or Bitmap Heap Scan. |
| L1 | `Retry-After` is clamped to 1 s – 1 h (`retryFloor` = `retryFirst`). |
| L3 | An empty secret keeps the stored one only for the same URL. A new URL gets `secret_required` ("a new secret is required when the url changes"). In the Console, the placeholder becomes "URL mới cần secret mới: nhập hoặc bấm Tạo mới", and the form shows an error before anything is sent. |
| L4 | The Node example compares both the secret and the signature with `timingSafeEqual` through a `same()` helper. The Python example compares bytes (a non-ASCII `str` would raise) and only accepts ASCII digits for the timestamp. Go was already constant time. I ran the Node and Python examples against valid and invalid inputs. |
| L6 | `::ffff:0:0:0/96` (SIIT) is blocked. |
| Console | The delete card text is now the one Jev decided. The Token side card has no code block: it shows "Bot nhận update bằng long poll.", "Lần cuối nhận update" and a link "Cách nhận update" that opens the Nhận update tab. The Nhận update long-poll view shows a `curl -sS -G … \` command with `-d offset=0 -d timeout=50`, `<token>` quoted, line breaks only after `/` inside the path (`<wbr>`) and a "Sao chép" button. |
| Stats | `Stats` returns, for each number, the larger of the hourly counters and the stored updates of the last 24 h. From stored updates: received = row count, delivered = rows with `delivered_at`, failed = sum of `attempts`, dead-lettered = rows with `dead_at` in the window. Long-poll acks now set `delivered_at`. Each source only ever misses events: counters exist only since webhooks shipped, and callbacks are kept 15 minutes. So the larger number is the closer one. The query reads the bot's primary-key range (at most a day of its updates). |

The mock was updated before the code: `mockups/console.html` sections #token, #webhook, #stats and #create-bot, plus a `.command` style. Docs updated: `server/README.md` (env table, BotAdmin RPCs, dispatcher, safehttp), `docs/bot-api/README.md`, `spec/bot-api/openapi.yaml` (Retry-After floor, 64 KiB answer), and the `bot_admin.proto` comments with regenerated Go and TS. Also updated: `docs/deployment-guide.md`, `docs/infrastructure-inventory.md` and `infra/chat/.env.production.example`.

## Files

- New:
  - `server/internal/botupdates/slots.go`
  - `server/internal/botupdates/dispatch_test.go`
  - `apps/web/src/messaging/bots/dialogs.tsx` (the shared ReauthDialog, ConfirmDialog, reauthUrl, TabProps and useConfirmShown, moved out of `console.tsx`)
  - `infra/chat/sw-kill-switch.js`
- Changed: 38 files, +1099 / −281 (`git diff --stat`). The main ones:
  - `rpc/bots_service.go`
  - `botadmin/botadmin.go`
  - `botupdates/{dispatch,webhook,botupdates}.go`
  - `safehttp/safehttp.go`
  - `config/config.go`
  - `api/api.go`
  - `bots/{console,delivery}.tsx`, the copy files and `console.css`
  - the nginx conf
  - docs, spec and proto
- Visual harness: five Console pages added to `test/visual` (`console-profile`, `console-token`, `console-webhook`, `console-poll`, `console-stats`). The overflow audit now covers them permanently.

## Gates

- `gofmt -l`: no output. `go vet ./...`: clean. `golangci-lint run ./...`: `0 issues.`
- `go test -race` on the changed packages, then `go test -race -count=1 -p 2 ./...`: 27 packages ok, exit 0, nothing failing. New tests:
  - `TestSlotsBoundTheProcessAndShareFairly`
  - `TestIdleWorkerDoesNotPollTheDatabase` (no database reads during 2.5 s while idle)
  - `TestOversizedAnswerIsDeliveredWithoutItsAction`
  - `TestHeadsQueryUsesThePendingIndex`
  - `TestStatsCountStoredUpdatesWithoutCounters`
  - `TestDeniedRangesAreRefused`
  - `TestHostAddressesArePublicSingleAddresses`
  - `TestLoadOutboundDeny`
  - extended: `TestTokenNeedsRecentSignIn`, `TestWebhookSettingsAreChecked`, `TestBotWebhookThroughTheConsole`, `TestRetryDelay`
- `pnpm lint`: eslint with `--max-warnings=0` and check-brand, both clean. `pnpm typecheck`: core, platform-web and web all done.
- Vitest with `--maxWorkers=2`: web 32 files / 330 tests, core 23 / 765, platform-web 5 / 17, brand 1 / 11, all pass.
- `pnpm perf`: startup JS 146.3 KB gzip against a 150 KB budget, unchanged because the Console code stays lazy. Startup CSS 16.7 KB. All budgets met.
- `pnpm e2e`: pass 20, fail 0.
- `npx @redocly/cli lint spec/bot-api/openapi.yaml`: valid, 0 warnings.
- gitleaks:
  - The diff of this change plus the new files: no leaks.
  - Whole tree / history: 2 / 4 `generic-api-key` hits, all in test fixtures this change does not touch: `apps/web/test/app.test.tsx` and `messaging-units.test.ts` (commit 549219c6), and `server/internal/media/fixtures_test.go` and `api/media_test.go` (8239fd06).
- Playwright render check of the five Console pages at 1000×700, 1333×780 and 390×844, light and dark: 30 renders, 0 errors, so no horizontal overflow. Screenshots are in `plans/dattqh/reports/shots-261015-webhook-hardening/` (2.1 MB).
- nginx: no local nginx or docker here, so `nginx -t` was **not** run. A vitest test checks the `location = /sw.js` block textually. `activate-release.sh` runs `nginx -t` and rolls back on failure.

## Decisions I made

- L1: floor of 1 s on `Retry-After`, as the reviewer proposed. I did not take max(Retry-After, exponential backoff), because that would also lengthen the explicit short waits a bot asks for.
- L3: a new secret is required on any URL change, not only when the host changes, because it is simpler and stricter. The Bot API path already required a secret.
- H1 draft storage: the secret travels in `sessionStorage` for the sign-in round trip, so the confirmation can save exactly what was entered. The risk is acceptable: the value is tab-scoped and validated, it lasts at most 15 minutes and is removed on read, and the bot owner's own server holds the same secret. The alternative was to make the user enter the secret again after signing in.
- Stats: I used greatest(counters, stored) rather than stored rows alone. Using only stored rows would have lost callbacks after 15 minutes.
- Link previews use the same deny list. Same invariant, one line in `api.go`.
- Kill-switch override directory (`/opt/chat/sw-override`): it survives automatic deploys, and removing it needs no nginx reload.

## Concerns

- Stats now aggregates the bot's stored updates on every `GetBotDelivery`, which the Console refreshes every 5 s while a delivery tab is open. That is cheap at today's volume. A bot with around 100k updates a day would make each call scan around 100k rows through the primary key. If that becomes real, add an index-only path with a `(bot_id, created_at) INCLUDE (...)` index.
- The safety recheck of idle workers is now 1 minute. If a second api process ever stores updates (overlap during a deploy), a bot's webhook can see up to 1 minute of extra delay. That is within the documented single-process assumption.
- Under saturation, a freed slot wakes waiting workers, and each one reads the database. The number woken is bounded by the free slots, not by the number of waiting bots.

## Unresolved questions

- M2 (carried over from the review): which other vhosts on .65 trust requests from the server's own IP? This change closes the path from the app; whether to audit the other vhosts is up to the operator.
- Whether the screenshots folder (2.1 MB of PNG) should be committed, or kept local only.

Status: DONE
Summary: H1, M1–M4, L1/L3/L4/L6, the Console copy, the Stats backfill, the token side card and the curl command are implemented with tests, docs, spec and mock. All gates pass: Go race full, golangci-lint 0, lint, typecheck, vitest, perf 146.3 KB, e2e 20/20, redocly, gitleaks on the diff.
Concerns: Needs a root deploy (nginx) and `OUTBOUND_DENY_CIDRS=103.72.98.65` in `/opt/chat/.env`. `nginx -t` was not run locally. The Stats query scales with the bot's daily volume.
