# Unread/read audit — delivery 1 (2026-10-16)

## Root causes (proven by tests that failed before the fix)

1. **Owner bug (a), donv case — badges stay after reading.** `MessageList` was not keyed per chat. Its `lastRead` ref carried over from the previous chat, and the mark-read check `topSeq <= lastRead` blocked reading any chat whose newest seq was lower. Chat 11 (seq 12) opened after chat 4 (seq 15) was never marked read from that tab. Test: `apps/web/test/unread.test.tsx` "reads the chat opened after a chat with more messages" (server read stayed 0 before the fix).
2. **Owner bug (b), chat 4 — divider stale vs unread count.** `ChatStore.openWindow` returned early for a kept (cached) window, so the divider from the first opening (seq 9) was reused. The client's read position was not stale: a two-device core test shows `readInboxMaxSeq`/`unreadCount` are right. e622532 then hid the divider entirely (an own reply after seq 9), even though seq 15 was unread. The server does **not** move the read pointer on send; the coordinator's premise was wrong, and the client doesn't need to mirror anything.
3. The "@" badge never changed live: `unread_mentions_count` was written only by a full dialog fetch, and `UpdateRead` had no mention count.
4. Forum topics were read against the chat-level pointer. That pointer moves to the chat's newest seq when any topic is read, so other topics were never marked read.
5. Opening by deep link on a fresh device: the history page was counted as unread from seq 1 (read 0) before the server read state arrived.
6. The title and app badge came from a separate async core query, so they could lag the list and folder badges.

## Findings

| # | Expected | Actual (before) | Fixed |
|---|---|---|---|
| 1 | Divider above first incoming msg after read pointer, every opening | Kept window reused old divider; hidden after own reply | Yes |
| 2 | Opening/reading a chat clears row, rail, title, app badge (all tabs) | Not marked read after a chat with higher seq | Yes |
| 2 | Messages read as they come into view | Read only when at the bottom | Yes |
| 3 | Read elsewhere clears badges here | Worked in core; covered by new tests | Guarded |
| 3 | Muted counted per "badgeMuted" | Correct; title/app badge now from same data | Yes |
| 4 | Topics read per topic | Second topic never read | Yes |
| 5 | New msg at bottom: no badge flash; scrolled up: counter increments | Flash; no per-view counter | Yes (live read in store) |
| 6 | "@" appears live and clears on read | Never updated until refetch | Yes (proto field + core) |

## Files changed (mine only; others in the tree belong to the concurrent account-deletion work)

- proto/app/v1/updates.proto (UpdateRead.unread_mentions_count = 9)
- packages/proto-ts/src/gen/app/v1/updates_pb.ts, server/gen/app/v1/updates.pb.go (regenerated for updates.proto only)
- server/internal/chat/messages.go (1 line), server/internal/chat/display_test.go
- packages/core/src/model/types.ts (read update field hunk), packages/core/src/protocol/map.ts (read mapping hunk)
- packages/core/src/repo/writes.ts (putNewMessage mention count, putLocalRead, putRead hunks), packages/core/src/repo/repository.ts (countMentionsAfter), packages/core/src/repo/rows.ts (export parseEntities)
- packages/core/src/entities/index.ts (mentionsUser), packages/core/src/outbox/outbox.ts (markRead), packages/core/src/sync/engine.ts (fetchHistory)
- packages/core/test/support/fake-server.ts, packages/core/test/unread-state.test.ts (new)
- apps/web/src/messaging/data/store.ts (divider, live read, totals hunks), apps/web/src/messaging/data/source.ts, apps/web/src/messaging/data/pending-backend.ts, apps/web/src/messaging/data/topic-mapping.ts, apps/web/src/messaging/data/server-backend.ts
- apps/web/src/messaging/ui/message-list.tsx, apps/web/src/messaging/ui/conversation.tsx, apps/web/src/messaging/ui/rich-text.tsx, apps/web/src/messaging/messaging-root.tsx (comment only)
- apps/web/test/unread.test.tsx (new), apps/web/test/messaging-redesign.test.tsx, apps/web/test/support/fake-chat.ts
- apps/web/test/e2e/unread.e2e.ts (new, not yet run)

## Gates

- core vitest full: 25 files, 778 passed; web vitest full: 40 files, 390 passed (before the last small store edit); touched files re-run after it: core 3 files / 16 passed, web 4 files / 95 passed
- `pnpm lint`: exit 0 (eslint 0 warnings, check-brand ok); `pnpm typecheck`: exit 0, 6 packages
- `go test -race ./internal/chat/` ok; `./internal/api/` ok; `go build ./...` ok; go vet chat ok
- gitleaks on new/changed files: no leaks
- Not run: `pnpm perf`, `pnpm e2e` (deferred by the controller; another agent's e2e stack held the ports)

## Unresolved

- Badge totals now count the store's dialog list (up to 1000 dialogs) instead of every local dialog.
- In a forum topic, the view anchors on the topic divider only when it is within the loaded window.
