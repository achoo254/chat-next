# Review batch 2: implementation report

Status: DONE. All seven items are implemented, the mocks were updated first, and every gate passes. Nothing was committed or deployed. No root deploy is needed: nginx and scripts are untouched. A normal deploy applies the expand-only migration `0014_bot_last_update_fetch.sql`.

## Items

1. **Channel posts.** In a channel, `message-item.tsx` no longer treats the viewer's own posts as "mine". Every post, the owner's included, renders as `msg post` on the left, with the channel name in `.who`, reactions at the bottom right, and no read ticks. Posts still being sent use the same layout and show the channel name. Recalled and system messages are unchanged. The mock (`chat.html#channel`) already showed this.
2. **Sessions.**
   - (a) `/auth/login` is a same-site navigation, so it can read the `SameSite=Strict` session cookie. It stores that cookie's token hash in the sealed login cookie (`loginState.Replaces`). The callback creates the new session and then calls `Sessions.Replace`, which uses `store.ReplaceSession` to revoke the old one with a new additive reason, `SESSION_REVOKE_REASON_REPLACED = 6`.
     - **Clients:** core `start-app` handles `replaced` by reconnecting (the cookie now holds the new session) instead of wiping local data. Other tabs of the same browser keep working.
     - **IdP:** the old refresh token is erased from the DB. It is revoked at the IdP only when the two sessions cannot share a grant (a different user, or both `sid`s known and different). This matters because hoandat-auth reuses the browser-session grant on every sign-in (`grant-builder.ts`), so revoking could end the new session's grant. ADR 0006 records this.
   - (b) `newLogin` is computed on the server (`rpc/auth_service.go`) and already followed the rule (24 h, never the current session). It is now `isNewLogin()` with a unit test of the 24 h boundary. The web never badges the current session. The badge seen in the review was on the duplicate session, which (a) removes.
   - (c) There is a new `recentTime()` helper in `format.ts` ("hôm nay 16:40", "hôm qua 21:52", otherwise "14/10/2026", with English equivalents). The detail line now follows the mock: "Hà Nội · hôm qua 21:52", capitalised when it starts the line. The `settings.html#sessions` mock was updated with the date and badge rules and an older-session example.
3. **Chat mới dialog.** `DialogHost`'s Suspense fallback is now a real modal shell: a title ("Chat mới" for newChat), a close button, and the shared `DelayedLoader`. Clicking "+" opens it at once, Esc and the close button work while it loads, and the native modal makes the page behind it inert, so clicks during loading no longer reach elements behind. The same applies to every lazy dialog. The mock note was added in `chat.html#new-chat`.
4. **Bot info panel.** The "Có trong 0 nhóm của bạn" row is hidden. The owner gets a "Quản lý bot" row linking to `/console/<botId>`, based on `GetBotInfoResponse.is_owner`. The mock is `chat.html#info-panels`.
5. **Bot not running.**
   - **Storage:** a new column, `bots.last_update_fetch_at`. `getUpdates` calls `botadmin.RecordUpdateFetch`, which writes at most once every 30 s per bot (`FOR UPDATE SKIP LOCKED`, so it never waits on the update writer's row lock).
   - **API:** the time is exposed as `GetBotInfoResponse.last_update_at` (owner only, together with `is_owner`) and `Bot.last_update_at` in ListMyBots.
   - **Banner:** in the owner's private chat, "Bot chưa chạy — chưa có chương trình nào nhận tin." appears when the last fetch is more than 120 s old. It links "Xem hướng dẫn" to `/console/<id>/token` and rechecks every 30 s (owner chats only).
   - **Console:** the token tab shows "Lần cuối nhận update: 15/10 16:40" or "Bot chưa nhận update lần nào".
   - **Dedupe:** GetBotInfo requests from the profile card, command menu, banner and info row are merged into one call.
   - **Mocks:** a new `bots.html#bot-not-running` shot and a `console.html#token` card.
   - There is no bot webhook delivery yet, so only the long poll is recorded.
6. **Cloud quick action.** A lone quick action now sits in the middle column (`.quick-acts > :only-child { grid-column: 2 }`), in both the mock and the app.
7. **Prefetch waterfall.** The second-level loaders are now exported and warmed: `loadConnectWeb`, `loadAccountClient`, `loadRemoteClient`, `loadBotsClient` and `loadIntegrationsClient`.
   - **Idle:** they are part of the idle prefetch.
   - **Navigation:** `warm()` starts them next to the screen's own code in `screenParts` (Console, Sessions, Privacy, Blocked) and for the webhook panes, so a direct navigation before idle no longer chains client, then connect-web, then RPC.
   - **Errors:** a failed warm is ignored, and the real call retries and reports it.

## Item 7: measured timings

Measured with production builds (`vite preview` of HEAD versus this change) on the e2e stack, using Chromium with CDP latency emulation. Each run signs in, waits 8 s idle, then navigates in-app. Content time is stamped in-page by a MutationObserver.

| Screen (86 ms RTT, prod-like) | Before | After | New JS after |
|---|---|---|---|
| Developer Console | 732 ms (5 JS: client, file, users_pb, chats_pb, then esm +210 ms, then ListMyBots +403 ms) | 108–110 ms | 0 |
| Settings, Sessions | 332–796 ms (account-client, file, users_pb, then esm) | 109–115 ms | 0 |
| Settings, Privacy | 735 ms (remote-client, file, users_pb, chats_pb, then esm) | 119–120 ms | 0 |
| Webhooks (`/c/<id>/admin/hooks`) | 200 ms (integrations client) | 103 ms | 0 |

At 180 ms RTT, every screen went from about 800 ms to 205–210 ms. After the change each screen issues only its one data RPC.

## Live verification (Playwright, e2e stack, 1333x780 and 390x844)

- Re-sign-in with `?reauth=1` kept the session count unchanged (2→2, and 4→4 on a second run). The other browser showed "Mới đăng nhập"; the current session did not.
- The channel post rendered as `msg post` with "Thông báo vận hành" in `.who`.
- The bot banner linked to `/console/<id>/token`, "Quản lý bot" was present, and there was no "Có trong 0 nhóm".
- No horizontal scroll on any of the six screenshots (sessions, channel and bot chat at both sizes). Screenshots are in the session scratchpad (`shots/`), not the repo.

## Gates

- `pnpm lint`: clean (eslint `--max-warnings=0`, check-brand).
- `pnpm typecheck`: clean across 6 projects.
- `pnpm test`: brand 11, core 762, platform-web 17, web 296. All pass.
- `pnpm perf`: all budgets met. Startup JS is 145.3 KB gzip (was ~144.7, budget 150). The 0.6 KB comes from the dialog shell, the warm loaders and the new copy keys. Startup CSS is 16.7 KB.
- `pnpm e2e`: 17/17 pass.
- `pnpm proto:lint`, `proto:breaking` and `proto:gen`: clean. All proto changes are additive (the enum value and three fields).
- Server:
  - `gofmt` clean, `go vet` ok, `golangci-lint` reports 0 issues.
  - `go test -race -count=1` on the changed packages passes, as does the full `go test -race -count=1 -p 2 ./...`.
  - New tests: `TestSignInAgainReplacesTheBrowsersSession`, `TestSignInWithoutASessionCookieReplacesNothing`, `TestIsNewLogin` and `TestGetUpdatesRecordsTheFetchForTheOwner`.
- `gitleaks` over the diff and new files: no leaks.

## Concerns

- Web bundles cached from before this change map `REPLACED` to "unknown", so their other tabs wipe local data once after a re-sign-in. This lasts until they reload the new bundle.
- The "not running" check compares the server's fetch time with the client clock when the answer arrived. A client clock more than about 2 minutes off could show or hide the banner wrongly.
- Changing the "Chat mới" dialog into a shell changed test timing. Three existing tests now wait for the loaded dialog through `test/support/new-chat-dialog.ts`; their assertions are unchanged.

## Sửa theo review

These fixes answer `code-reviewer-261015-1755-session-replace.md` (commit 00a5264). They are not committed.

- **M1, server.** The callback now sets the new cookie first and writes the interstitial with a `Content-Length`. It flushes the response and only then revokes the replaced session, on `context.WithoutCancel` with a 10 s timeout (`server/internal/auth/routes.go`, `pages.go`). The browser has the whole page and the new cookie before any `REPLACED` event exists.
  - Test: `TestSignInAgainSendsTheNewCookieBeforeRevokingTheOldSession` holds the old session's row with `FOR UPDATE`. The browser must get the page and the new cookie while the revoke is blocked, and the row must end up revoked with REPLACED once the lock is released.
  - Against the old callback this test fails with a client timeout "awaiting headers".
- **M1, client.** For 10 s after `replaced`, an `unauthenticated` result from the outbox, uploads, probe, history, search or sync no longer wipes anything (`packages/core/src/app/start-app.ts`). Instead it schedules one `GetSelf` re-check 1.5 s later, and repeated 401s share that one re-check. The result decides what happens:
  - Same user: the outbox and uploads restart, and the socket reconnects if it is not connected.
  - 401: the session ends as unauthenticated and the local data is wiped.
  - Another user: the session ends as `user_changed`.
  - Network error: the data is kept.
  - New tests: replaced, then a transient 401, then the re-check succeeds, so no wipe. Replaced, then a 401, then the re-check also gets 401, so the data is wiped, but not before the re-check. A 401 60 s after replaced still wipes at once. The first two fail without the fix.
- **M2.** `GetBotInfoResponse.not_running = 7` was added. It is owner-only and computed in `botadmin.Info` with the server clock: never polled, or more than 2 min ago. The web banner uses it, and `BotInfo.lastUpdateAt` was replaced by `notRunning`. The Console still shows `Bot.last_update_at`.
- **L5.** The banner refresh is rescheduled after a failed request. It stops only once the viewer is known not to own the bot. The new web test "keeps checking … also after a failed check" fails without the fix.
- **L1.** The comments in routes.go and pages.go and ADR 0006 now say that auth.hoandat.com and chat.hoandat.com are same-site, so the cookie does reach the callback. The hash still travels in the login cookie because an IdP on another site would not send it. The ADR also describes the new ordering and the client re-check.
- **L4.** This is documented, not changed (sessions.go `Replace`, ADR 0006).
  - hoandat-auth registers `chat-web` with `backchannel_logout_session_required: true` (hoandat-auth `src/oidc/chat-clients.ts:72`), so ID tokens always carry `sid`. An empty sid therefore means a row stored without one, and nothing proves the grants differ.
  - Revoking could sign the new session out at its next grant check.
  - The old refresh token is erased from our DB and lives no longer than its IdP session.
- **L6.** `botadmin.Service` keeps a per-bot "last written" time in memory and skips the DB for 30 s after a write. It records the time only when a row was actually written, so a locked row or another process's write means the next poll asks the DB again.
  - `TestRecordUpdateFetchAndNotRunning` covers the memory skip, the write after 30 s, the DB throttle from a second Service, and `not_running` for owner and stranger, including a +3 min clock.
  - The 10 s and 5 min steps of the botapi test moved there because they need a controllable clock (`export_test.go` `SetClock`).
- **L7.** Added `TestSignInAsAnotherUserOnTheSameBrowser`: the previous user's session is revoked with REPLACED and its RT is revoked at the IdP. Added `TestSignInAgainAfterTheOldSessionWasRevoked`: no error is logged and nothing is revoked at the IdP. The non-owner check (no timestamp, `not_running` false) is asserted in both the botapi and botadmin tests. The client 401 after replaced is covered by the M1 tests.

### Gates (sequential, run after the QA e2e stack finished)

- `gofmt -l`: empty. `go vet ./...`: ok. `golangci-lint run ./...`: 0 issues.
- `go test -race -count=1 -p 2` on auth, auth/idptest, api, botadmin and botapi: all ok. The 5 new or changed Go tests were confirmed PASS with `-v`.
- `pnpm lint`: clean. `pnpm typecheck`: 0 errors.
- vitest `--maxWorkers=2`: core 765/765 (was 762, plus 3 new), web 297/297 (plus 1 new). bots.test.tsx was run 3 times with no flake.
- `pnpm proto:lint`, `proto:breaking` and `proto:gen`: clean. The only change is the additive field 7.
- gitleaks over the diff and the new file: no leaks.
- Not run: `pnpm e2e` (the QA agent owns the stack) and the full `go test ./...`.
