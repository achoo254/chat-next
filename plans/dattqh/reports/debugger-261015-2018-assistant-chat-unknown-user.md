# Assistant chat shown as "Chat đã xoá" for an existing user

Status: fixed locally, not committed or pushed. Production was not touched.

## Root cause

The server sends the assistant chat to an existing account in one update, `member_added`. That update carries the chat but not the bot user. The bug needs three layers to line up:

1. **Server: frames left out the peer.** `EnsureSystemBotChat` (`server/internal/chat/assistant.go:74`) logs `member_added{user_ids:[me], inviter:me}`. `renderFrames` attaches the chat and the users named in the update, which is only the user. `entitySet.render` (`server/internal/chat/render.go`) never added the peer of a private chat. Only `GetDialogs`, `GetPeerDialogs` and `GetChat` added it, each by hand.
   - A probe test against the real service showed the difference frame: `users:[{id:1 lan}] chats:[{id:1 type:PRIVATE peer_user_id:1001}]`. The bot user was missing. `GetPeerDialogs` for the same chat did return the bot.
2. **Client: the peer was never fetched.** The core asks only for entities that `requiredEntities` lists. For `member_added` that is the user ids in the update, and the chat only when it is missing. Here the chat was already in the frame, so nothing was asked for the bot.
   - The only thing that brought the bot was the side effect added in 645241d: `member_added` for yourself queues `refreshChat`, which calls `GetPeerDialogs`. That call is fire-and-forget; a failure is only reported.
   - A build older than 645241d (an open tab, or another device during the deploy) never makes that call. It wrote the dialog and the chat with `peer_user_id=4` and no user 4. Its `pts` then moved past the update, so no later sync brings the bot back.
3. **Client: unknown users were never asked for.** `core.users()` (`packages/core/src/app/start-app.ts`) read only the local database. `useUser` → `store.wantUser` → `core.users` therefore returned nothing forever. The list, the header ("Truy cập đã lâu") and the info panel all treated the chat as a deleted chat with an unknown person. The bot profile card and "Bắt đầu" need `peer.isBot` (`conversation.tsx:261`), so they never appeared.

For a new account the first sync is `GetDialogs`, which already includes the peer. That is why the 645241d e2e test, which only covered a brand-new account (Giang), passed.

Evidence that user 1's device took the update through a path without the refresh is indirect. The server data is correct, and the frame provably lacked the bot. I did not read production logs (out of scope), so I cannot say which client build or tab applied it.

## Fix

- **Server** (`render.go`, `entitySet.render`): it now loads the chats first and adds each private chat's peer for that viewer. Every frame and response that carries a private chat now carries its peer. That covers `member_added`, `chat_updated`, search, moderation and differences.
- **Core** (`sync/engine.ts`): `fetchMissingEntities` now also asks for the `peerUserId` of every chat in a batch. This protects the client against a server that leaves the peer out.
- **Core** (`app/start-app.ts`, `engine.fetchUsers`): `core.users(ids)` fetches users this device never stored with `GetUsers`, stores them and returns them. This follows the existing `core.chat` refetch pattern. Failures are reported, not thrown.
  - This also repairs devices that already hold the broken chat, such as user 1's.
- **Web** (`data/store.ts`, `applyDialogs`): a private dialog whose peer is unknown now calls `wantUser(peerUserId)`. The list row repairs itself without the chat being opened. Once the bot is known, the existing UI shows the bot card and "Bắt đầu".

## Tests

- **Go:** `TestSystemBotChatUpdateCarriesTheBot` fails without the `render.go` change ("the frame's users miss the bot") and passes with it.
- **Core:** `test/private-chat-peer.test.ts` has 2 tests. Both fail without the core changes and pass with them. They cover:
  - an update without the peer, with the dialog refresh failing;
  - a device database that lacks the peer.
  - The fake server has a new `framesWithoutPeers` switch. It is needed because the fake attached every member to every frame, unlike the real server, which is how it hid this bug.
- **Web:** `test/assistant-chat.test.tsx` has 2 tests. Both fail without the client changes. Without only the `store.ts` change, the device-repair test still fails. They cover:
  - the chat arriving live without the bot;
  - a restart on a database without the bot.
  - In both, the list names the bot, "Chat đã xoá" never appears, and "Bắt đầu" shows. `renderMessaging` gained an optional `sql` argument so a test can restart on the same database.
- **E2E:** `assistant-existing-account.e2e.ts` adds a new account, Hạnh, in `e2e-stack` and `people.ts`. Hạnh signs in on two devices while the assistant is off. The assistant is then turned on with the new `POST /e2e/assistant?state=off|on` switch (`server/cmd/e2e-stack/assistant_switch.go`). One device reloads and the other gets the chat live; both show the bot row and "Bắt đầu".
  - For the switch, `api.RunWrapped`'s `wrap` now also receives `*App`. Its only callers are e2e-stack and `Run` (which passes nil).

## Gates

- `go test -race -count=1 -p 2` on `internal/chat`, `internal/api`, `internal/rpc`, `internal/assistant` and `cmd/e2e-stack`: all 5 ok.
- `gofmt -l`: empty. `go vet`: clean. `golangci-lint` on chat, api and e2e-stack: `0 issues.`
- vitest (`--maxWorkers=2`): core 24 files, 768/768; web 33 files, 333/333.
- `pnpm lint`: clean, including check-brand. `pnpm typecheck`: all 6 projects done.
- `pnpm e2e`: 23/23 pass (`ℹ pass 23`, `ℹ fail 0`), including the new existing-account scenario. The ports were free afterwards.
- gitleaks on my changed and new files: `no leaks found`.
- The runs included the other agent's uncommitted Bot API work in the same tree. Nothing of theirs was reverted.

## Recurrence prevention

- The server now has one place that attaches a private chat's peer (`entitySet.render`), instead of each RPC adding it by hand.
- The client no longer has a dead end for an unknown user. Anything that asks for one fetches it.
- Monitoring gap: client "fetch users" and "refresh chat" errors only go to the error report. Consider counting them server side, for example GetUsers or GetPeerDialogs failures per release.

## Unresolved questions

- Which client build or tab of user 1 applied the update is unconfirmed, because production logs were not read. The fix covers every path either way.
- User 1's device repairs itself once it runs this release; no data change is needed on the server.

## Follow-up: still "Chat đã xoá" after fb29dac

Reported on prod: the device runs the fb29dac bundle and still shows chat 7 as deleted. The server returns the right data for GetChat, GetPeerDialogs and GetUsers.

**What the original update carried.** The server put the right peer in it, so the server needed no change.
- I rendered `member_added` from `EnsureSystemBotChat` for the recipient through both paths:
  - the realtime sink frame;
  - `GetDifference`, before and after fb29dac.
- Both gave `chats:{type:PRIVATE peer_user_id:<bot>}`. The realtime frame after fb29dac also carries the bot user.
- `chatRow.render` takes `peer_user_id` from `peerOf(viewer)` over `chats LEFT JOIN private_chats`. It is never the inviter or self for this chat.
- The only client code that writes `peer_user_id` is `putChat`, which writes whatever server Chat it is given.

**Why the fb29dac repair could not help.** It only fetches the user named by the stored `peer_user_id`, and only when that id is not 0.
- This matches the symptoms: the list shows "Chat đã xoá", the header shows presence for an unknown person, and no GetPeerDialogs or GetChat call is made on load.
- So the stored chat (or dialog) is unusable in a way that fetching a user cannot fix: peer 0, a peer id the server does not know, self as peer of a two-member chat, or a dialog with no chat row (for example a chat purged as `left` while its dialog stayed).
- I could not read the device's database, so which of these it is remains unproven.

**Fix.** The repair now reloads the chat itself.
- `Repository.dialogsToRepair(selfId)` lists the dialogs that cannot be shown:
  - no chat row;
  - a private chat whose peer is 0;
  - a peer with no stored user;
  - the user as peer while `member_count > 1`. Only Cloud của tôi has the user as its own peer, and it has one member.
- Once per start, after the first successful GetDifference, `SyncEngine.repairDialogs` reloads those chats with GetPeerDialogs, 100 per call. It overwrites the stored chat, dialog and users through the existing `refreshChat` path, now `refreshChats(ids)`. Without GetPeerDialogs it falls back to GetChat. Failures are reported, not thrown.
- Chats that show fine cause no call.

**Tests.**
- Core `private-chat-peer.test.ts`: 4 new restart cases fail without the repair (4 failed / 3 passed) and pass with it. Each one damages the device database, removes the bot user, restarts the app on the same database, and expects the chat with peer = bot, `memberCount` 2, and the bot user. The cases are:
  - peer 0;
  - self as peer;
  - an unknown peer id;
  - no chat row.
- Core `private-chat-peer.test.ts`: 1 more case checks that a healthy device makes no GetPeerDialogs call on start.
- Web `assistant-chat.test.tsx`: a new "peer 0" restart case fails without the repair and passes with it. The list names the bot and "Bắt đầu" shows.

**Gates.**
- vitest (`--maxWorkers=2`): core 773/773, web 339/339.
- `pnpm lint`: clean.
- `pnpm typecheck`: every project passes except apps/web, which has 3 errors in `test/service-worker.test.ts` (lines 46-48). That file is in another agent's uncommitted service-worker work (`src/sw/*`), not my change.
- `pnpm e2e`: 23/24. "an existing account gets the assistant on its next start and live on its other device" passes. The one failure is the other agent's in-progress scenario in `bots.e2e.ts:264` ("the bot edits its message…", waiting for the "Xem kết quả" button), which is unrelated.
- gitleaks: no leaks found.
- No Go change in this round.

**Files changed in this round:**
- `packages/core/src/sync/engine.ts`
- `packages/core/src/repo/repository.ts`
- `packages/core/test/private-chat-peer.test.ts`
- `apps/web/test/assistant-chat.test.tsx`
- `plans/dattqh/reports/debugger-261015-2018-assistant-chat-unknown-user.md`

**Unresolved.** The exact damaged state of user 1's database (peer 0, an unknown id, or no chat row) is unproven without reading it. The repair covers all of them. After this deploy, one reload should show chat 7 named with "Bắt đầu"; if it does not, the next step is to read chat 7's local `chats` row on that device.
