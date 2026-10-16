# R9 — xuất dữ liệu, xoá tài khoản chat, tự xoá khi không dùng (Phase 12)

Status: DONE_WITH_CONCERNS (code complete, my gates green; two shared gates are red because another session edits the same working tree, see Concerns)

## What shipped

- Mock first: `mockups/settings.html#export-delete` extended (ticks per Jev decisions, owned-chat blocker list, bot notice, export progress frame, grace screen "Huỷ xoá tài khoản" incl. inactive wording, "Người khác thấy" frame).
- Proto (additive, `buf breaking` clean): new `proto/app/v1/privacy.proto` (`PrivacyService`: GetDataExport, RequestDataExport, GetDataExportUrl, GetAccountDeletion, SetAutoDelete, DeleteAccount, CancelAccountDeletion); `User.deleted = 12`; `GetSelfResponse.deletion = 3` (+ `AccountDeletion`, `AccountDeletionReason`); `SessionRevokeReason.ACCOUNT_DELETED = 7`.
- Migration `server/migrations/0019_account_deletion_export.sql` (expand-only): `users.deletion_requested_at/deletion_reason/deleted_at/auto_delete_months`, relaxed `users_idp_sub_unless_bot` (erased accounts have no `idp_sub`), table `data_exports`, partial indexes.
- Server: `server/internal/privacy/` (deletion, erasure, inactivity scan, export queue/builder/ZIP/HMAC download, hourly jobs), `server/internal/chat/accounts.go` (owned chats, announce to private peers, leave-all with ownership hand-off), `server/internal/rpc/privacy_service.go`; session lookup carries the lock (`store.ActiveSession` joins users), RPC interceptor allows only GetSelf/CancelAccountDeletion/SignOut while locked, `/ws` 403; deleted users render as `deleted` with empty profile, cannot be found/messaged/added; bot tokens refused and webhooks paused while the owner waits for deletion (restored on cancel), bots deleted with the account; `auth.Sessions.RevokeAll` revokes every session and IdP refresh token; config `DATA_EXPORT_DIR` (default `MEDIA_ROOT/exports`).
- Web: Settings › Tài khoản (`apps/web/src/messaging/settings/account-settings.tsx`, lazy, Connect client `privacy-client.ts` loads with the tab), reauth round trip reusing the console's `ReauthDialog` + single-use `?after=delete` + typed confirmation (no auto-action), grace screen `apps/web/src/screens/deletion-pending.tsx` (own chunk, own copy), deleted users shown as "Tài khoản đã xoá" (core `User.deleted`, local SQLite migration v11, store naming), composer replaced by "Không nhắn tin được cho tài khoản đã xoá." for a deleted peer.
- Docs: `docs/privacy/data-inventory.md` (new), `docs/README.md`, `docs/deployment-guide.md` (section "Xuất và xoá dữ liệu"), `docs/infrastructure-inventory.md` (`/opt/chat/media/exports`), `server/README.md`, `infra/chat/.env.production.example`; phase-12 todo "Xoá/tự huỷ/xuất dữ liệu" checked, decisions recorded.

## Decisions taken (Jev's, plus the open sub-points)

- Grace: confirming locks at once; during grace others already see "Tài khoản đã xoá" (least surprising: the user said delete). Private chat partners are told immediately (`chat_updated`); members of shared groups see it the next time the user appears in an update or lookup (no new update kind).
- Export scope: own data only — profile + settings, contacts, blocked, sessions (UA/IP/dates), bots (no token), chat list (private chats name the peer only), messages the user sent per chat (JSON + HTML), Cloud của tôi, files attached to own messages (cap 4 GB, rest `included:false`). No other people's messages; replies keep only `reply_to_seq`.
- Erasure: private chats are deleted when the other side is a bot or already erased (incl. assistant chat) and the saved chat; private chats with a living person stay. Reactions, reports filed and moderation log are kept (documented). Inactive path only: owned groups pass to the longest-serving admin, else longest-serving person; empty → deleted.
- Failed exports do not count toward the 7-day limit; the account lock cancels a running export.
- Jobs run hourly (purge, inactivity scan, export expiry) rather than daily; export builder wakes on request + every 30 s.

## Tests and gates (evidence)

- `gofmt -l` clean; `go vet ./...` clean; `golangci-lint run ./...` → `0 issues.`
- `go test -race -count=1 -p 2 ./...` → all 32 packages `ok` (api 33 s, chat 42 s, privacy, botupdates…). New: `internal/api/privacy_test.go` (export contents/HTML escaping/no foreign messages/7-day limit/expiry 404/forged token 403; reauth → owns_chats → wrong confirmation → lock: sessions revoked + IdP revocation, others see `deleted`, `account_deleted` on send, not resolvable, bot 401; grace sign-in only GetSelf/Cancel, `/ws` 403; cancel restores bot + profile; erasure: username `deleted_<id>`, `idp_sub` NULL, sessions/contacts gone, only Bình's private chat left, bot deleted + username released, Bình keeps the message from a deleted author, re-sign-in creates a new user with the username; inactive scan with ownership transfer), `internal/privacy/export_test.go` (token, safe names), `botupdates` `TestWebhookPausedWhileTheOwnerAccountWaitsForDeletion`, config test.
- Web: `pnpm typecheck` all Done; vitest `test/account.test.tsx` 8/8 (route + GetSelf parsing, export request/progress/download, unavailable, auto-delete, blocked by owned chats, reauth → `?after=delete` → typed confirm → sign-out, grace screen cancel, deleted account in list + composer note); core vitest 25 files / 778 tests pass (incl. deleted-flag round trip).
- E2E `pnpm e2e account`: 3/3 pass (export ZIP downloaded via media host, contains README/profile.json/chats.json/index.html; delete with reauth → welcome → sign in → grace screen → cancel → delete again → `/e2e/privacy?action=purge` → Bình sees "Tài khoản đã xoá" + composer note → re-sign-in is a new account). No horizontal scroll checked at 1333×780 and 390×844 (tab and grace screen); screenshots reviewed.
- Proto: `buf lint`, `buf breaking` (vs main) clean; generated code in sync.
- gitleaks: `no leaks found` on every new/changed path and on `git diff`.

## Concerns

1. A parallel session is editing the same tree (unread work: `store.ts`, `message-list.tsx`, `conversation.tsx`, `messaging-root.tsx`, core `writes.ts`/`repository.ts`, `updates.proto`, `unread*.test.ts`). Because of it, right now: `pnpm lint` fails on their unused `changed` in `apps/web/src/messaging/data/store.ts:437`; 3 web vitest cases fail (unread divider/mention, `messaging*.test.tsx`, `unread.test.tsx` — they also fail with my changes stashed); full `pnpm e2e` was 23/30, 26/30, 28/30 on three runs with different failures each time (block scenario fails only in the full run; it passes alone and in the exact order account → assistant → block). My files' eslint is clean. I briefly `git stash`/`pop`ed web+core paths once to check the unread failures (restored cleanly), and did not touch their files.
2. Startup JS (gzip) is 150.6 KB vs 150 KB budget with both sessions' changes in the tree. Mine measured 149.1 KB before their latest edits; my startup share (GetSelf deletion parse, boot branch, key icon, store naming, account nav link, composer note, copy) is about 0.8 KB; the account tab, its client and the grace screen are lazy. Needs a call once their work lands (trim or raise the budget).
3. Not done (not in this task): the ND13 cross-border assessment file (`nd13-assessment.md`) — inventory notes it as pending; profile photos don't exist yet, so "avatar" deletion is a no-op.

## Deploy notes

- Migration `0019_account_deletion_export.sql` runs with the deploy (`SET LOCAL lock_timeout = '5s'`; ALTERs on `users` + one CHECK revalidation scan — tiny table).
- No new env var needed in prod: exports go to `/opt/chat/media/exports`, created by `chat-api` (chat:chat 0750) at start; startup log `"msg":"data exports","enabled":true`. `DATA_EXPORT_DIR` only to relocate (required for S3 storage).
- Disk: one export at a time, up to 4 GB of attachments + JSON/HTML per ZIP, keeps `MEDIA_MIN_FREE_BYTES` free (else `failed/disk_full`), files deleted 30 days after ready (hourly job).
- nginx: no change (downloads are `https://media-chat.hoandat.com/f/export/<token>`, inside the existing `location ^~ /f/`, token redacted in the access log) → no root deploy needed for nginx; `infra/chat/` changed only in `.env.production.example` (docs), so a normal CI deploy suffices.
- Erased data stays in DB backups up to 14 days (documented in the inventory).

Unresolved questions:
- Budget decision for startup JS once the parallel unread work is merged.
- Should group co-members get an immediate refresh of a deleted account's name (needs a new update kind; currently on next appearance)?
