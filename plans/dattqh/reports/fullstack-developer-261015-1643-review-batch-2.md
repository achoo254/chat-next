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
