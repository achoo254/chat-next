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
