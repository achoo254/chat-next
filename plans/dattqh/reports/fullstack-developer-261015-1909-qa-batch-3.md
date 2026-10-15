# QA batch 3: usernames, offline, topics, refused chats, small fixes

Date: 2026-10-15. Source: `tester-261015-1755-multi-user-qa.md`. Decisions implemented as given by the Jev model. Nothing was committed or pushed, and production was not touched.

## Outcome

All eight items are done and verified in a browser on the local e2e stack at 1333x780 and 390x844. The gates pass except two lint findings in files that another session is editing at the same time (see Concerns). **Root deploy: no.** nginx does not change: `location /` already sends `Cache-Control: no-cache` for `/sw.js` and `/index.html`, and the CSP already has `worker-src 'self'`.

## What changed

| Item | Change |
|---|---|
| M-2 username | A login name shorter than 3 characters after normalisation keeps its letters and gets numbered digits padded to the minimum length: `an` becomes `an1`, then `an2`, and so on; `x` becomes `x01`; a name with no usable characters becomes `001`. "user" is never produced. Longer names keep the old rule (`dat`, `dat2`, …). Existing users are not renamed. `server/internal/profile/profile.go`, with tests in `profile_test.go` and `store/store_test.go` (`TestUpsertIdPUserShortLoginName`). In the e2e stack An is now `@an1`. |
| M-4 offline state | New `messaging/data/connection-status.ts` sits between the core's socket state and the screens. When `navigator.onLine` is false (or the `offline` event fires), the screens show "offline" at once: header "Chờ mạng", the banner "Ngoại tuyến — n tin sẽ gửi khi có mạng", and the placeholder "Tin sẽ gửi khi có mạng". When the socket drops (heartbeat timeout or close) while the device is online, the header shows "Đang kết nối…". After 10 s without a connection it switches to the no-network state, so the header does not flip on every reconnect attempt. Recovery follows the core (`online` event, then reconnect and sync). |
| M-4 test | `server/cmd/e2e-stack/realtime_switch.go` adds `POST 127.0.0.1:4600/e2e/realtime?state=down\|up` to the e2e stack only. It closes every hijacked `/ws` connection and refuses new ones. `api.RunWrapped` lets the stack wrap the handler; production still calls `api.Run`. New e2e `apps/web/test/e2e/connection.e2e.ts` covers two cases. (1) Device offline: header, banner, placeholder and the queued clock appear, then the message reaches Bình exactly once after reconnect. (2) Server drops the socket: "Đang kết nối…", then "Chờ mạng" with the banner, then recovery, and Bình's message sent during the outage reaches An. |
| M-5 offline reload | A service worker (`src/sw/service-worker.ts`, built to `/sw.js` by `vite-service-worker.ts`) is registered in production builds only. It precaches only the build's files: `index.html`, everything under `/assets/` (JS, CSS, fonts, SQLite wasm), the icons and the manifest. 112 files measured. It never handles `/rpc`, `/ws`, `/auth`, `/hook`, `/bot`, `/healthz`, `/e2e`, non-GET requests or other origins such as the media host (allowlist in `src/sw/shell-routes.ts`). Page loads are network first, with the cached shell used offline. The cache is named `app-shell-<hash of the build's contents>`. A new worker does not skip waiting: it takes over only after every tab of the old build is closed, and only then deletes the old cache, so a running tab never loses its chunks. A tab opened online always gets the newest `index.html`. The mock has no "Có bản mới" hint, so none was added. The shell alone was not enough, because the app showed a network error when GetSelf failed. `src/api/offline-self.ts` now remembers the signed-in user, and the app opens from it when the server cannot be reached. It is used only while the core's local data belongs to the same user (`chat:last-user`) and is cleared on sign-out and on a 401. |
| M-6 topics | Mock first: `#new-group` gains the switch "Nhóm có chủ đề", and `#chat-admin` gains a "Chủ đề" card with "Bật chủ đề", which locks on once enabled. The server already had everything (`CreateGroupRequest.forum`, `UpdateChatInfoRequest.forum`, admins only, cannot be turned off), so the web only passes `forum` and calls `remote.enableTopics`. The server names the default topic "General", which showed in English. `useTopics` now shows it as "Chung" (mock and copy) unless an admin renamed it. |
| M-3 refused chat | Every place that opens a private chat uses `ui/private-chat-failure.ts`. A PermissionDenied from CreatePrivate (the person's setting or a block, but not the caller's own `account_restricted`) shows "Không thể nhắn tin cho người này lúc này." It adds "Bạn có thể mời họ vào nhóm bằng link mời." when the user can invite in one of their groups or channels (owner, admin, or the "add members" permission), or when they share a group with the person (GetCommonChats). Other errors keep the generic message. |
| L-1 | The "⌘K" hint is hidden at ≤760 px and on `pointer: coarse` screens. |
| L-2 | Additive proto change: `GetSelfRequest.allow_signed_out`. The start-up probe sets it, and the server answers 200 without a user instead of 401 (no cookie, or an unknown session), so a signed-out start logs no failed request. `GetSelf` without the flag still answers Unauthenticated. `buf breaking` against `main` passes. |
| L-3 | While a composer is on screen, the toast sits above the composer and its hint line. Measured: the toast ends at y=664 and the composer starts at y=695. |
| M-7 | The Vite proxy forwards `/hook/` with the original Host. `POST localhost:5173/hook/abc/secret` now returns the app's `{"error":"hook_not_found"}`, the same as the api direct, instead of Vite's 404. |

Docs: ADR 0009 (web shell cache and the remembered user), deployment guide (service worker, `no-cache` requirement, no nginx change), README (realtime switch of the e2e stack).

## Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass, all 6 packages |
| `pnpm lint` | ESLint finds 1 error, in `apps/web/src/messaging/bots/delivery.tsx` (`react-hooks/rules-of-hooks`). `check-brand.mjs` finds 2, in `bots/copy-en.ts:182` and `bots/copy-vi.ts:185`. All three files belong to the other session's in-progress work. ESLint with only that file excluded: 0 problems. |
| `pnpm test` (Vitest, maxWorkers 2) | pass: web 324 tests in 32 files, core 765, platform-web 17, brand 11 |
| `pnpm perf` | all budgets met. Startup JS 146.8 KB of 150 (was 145.3); startup CSS 16.7 of 20 KB; open chat from cache p50 18 ms, p99 28 ms. The build also prints Vite's warning that a chunk is larger than 500 kB. |
| `pnpm e2e` | 20 of 20 pass, including the 2 new connection scenarios. The `[vite] write EPIPE/ECONNRESET` lines are the dev proxy logging the sockets the switch cut on purpose. |
| Go | `gofmt -l` is clean; `go vet ./...` OK; `golangci-lint run ./...` 0 issues; changed packages run with `go test -race -count=1`, then `go test -race -count=1 -p 2 ./...`: all 27 packages ok |
| Proto | `buf lint` OK, `buf breaking` against `main` OK, regenerated code up to date |
| gitleaks | My diff (`gitleaks stdin`): no leaks. A directory scan of the changed files flags only the existing test invite token at `apps/web/test/app.test.tsx:41`, which is already in HEAD. A gitleaks scan of the HEAD commit is clean. |

Browser checks (Playwright, screenshots in `fullstack-developer-261015-1909-qa-batch-3-shots/`):

- `m4-offline-banner-{desktop,mobile}`: "Chờ mạng", the banner with "1 tin sẽ gửi khi có mạng", the offline placeholder, and the clock on the queued message.
- `m5-offline-reload-{desktop,mobile}`: production build under `vite preview` with the service worker active and controlling the page. Then the preview server was killed, the context set offline, and the page reloaded. The chat list and messages load from the local database, showing "Chờ mạng" and "Ngoại tuyến". The cache held 112 entries, including `index.html` and the wasm, and 0 API paths.
- `m6-create-topics-dialog-{desktop,mobile}`, `m6-topics-created-{desktop,mobile}`, `m6-topics-list-mobile`, `m6-admin-topics-{off,on}-desktop`.
- `m3-refused-desktop`, `m3-refused-hint-desktop` (Chi set "Nhắn tin cho tôi: Danh bạ").
- `l1-mobile-list-no-kbd`, `l3-toast-above-composer-desktop`.
- No horizontal scroll: `scrollWidth` equals `clientWidth` on every checked screen at both sizes (list, create group, topics, admin, chat while offline).
- Console: no 401 on signed-out loads. The only errors left are the expected 403 for the refused chat and the network failures while offline.

## Concerns

- Another session edited the same working tree during this batch (bot webhooks: `botupdates`, `chat/bots.go`, `config`, `safehttp`, `rpc/bots_service.go`, `rpc/handler.go`, migration `0015_bot_webhooks.sql`, `bot_admin.proto`, `apps/web/src/messaging/bots/*`, `console.html`, `docs/README.md`). I did not touch those files. For a while `botupdates` did not compile, which delayed my server tests. The three lint findings above are theirs. `pnpm proto:gen` also regenerated `bot_admin` code, deterministically from their proto change. Commits need to separate the two sets of changes.
- I followed the rule of one heavy job at a time, but twice another session started `go test` while my e2e or Go suite was already running. Free memory stayed at 62–65%.
- Test isolation fix: the invite-link cache in `ui/members.ts` is per page session, which is fine in production because sign-in always reloads the page. In Vitest it leaked between renders when chat ids collided. I added `inviteLinks.clear()` and call it from `test/setup.ts`.
- Users whose login name is shorter than 3 characters and who already have `@user`/`@userN` in production keep it, as decided. They can change it in Settings.
- The offline reload was checked in headless Chromium with Playwright, not on a real phone in airplane mode.

## Unresolved questions

None.

Status: DONE_WITH_CONCERNS
Summary: Implemented M-2, M-3, M-4 (with an e2e that really drops the WebSocket), M-5 (app-shell service worker plus offline boot), M-6 (mock first), L-1, L-2, L-3 and M-7. Typecheck, Vitest, perf, e2e, Go, proto and gitleaks pass, and no root deploy is needed.
Concerns: `pnpm lint` fails only on another session's in-progress bot files (`delivery.tsx`, `bots/copy-*.ts`), and the working tree mixes that session's changes with this batch.
