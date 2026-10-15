# Code review: R5 slice A, Bot API core (backend)

Date: 2026-10-15. Scope: uncommitted changes under `server/`, `proto/`, `spec/bot-api/`, `infra/chat/`, `docs/` (about 6.1k new lines and 600 changed). This was a read-only review. I ran no tests: every finding below follows directly from the code paths cited.

## Summary

The trust boundaries hold up. Token handling, tenant/host gating, the consent invariant, privacy-mode filtering, PressInlineButton authorization, the reauth/auth_time logic and the URL allowlist are all correct. The real defects are in the **update consumer's delivery guarantees**: a replay re-delivers updates the bot already acknowledged, and a single bad outbox row stops delivery for every bot. There are also spurious `message_edited` updates, an N+1 query pattern in the consumer, and a few contract and ops mismatches.

---

## Critical

None.

## High

### H1. A replay re-delivers updates the bot already acknowledged (duplicate command execution)
- `server/internal/botupdates/botupdates.go:172-173`: on restart, or after any failed pass (`s.loaded = false`, `:230`), the consumer resets to the **persisted** cursor. That cursor is `min(pending gap) - 1` (`:210-217`), so it can be up to `gapTTL` (30 s) of rows behind what was already cut.
- The only dedupe is `ON CONFLICT ON CONSTRAINT bot_updates_outbox_key DO NOTHING` (`:298-302`). The bot's ack, however, **deletes** those rows (`Poll`, `:408-412`: `DELETE FROM bot_updates WHERE bot_id = $1 AND update_id < $2`).
- Failure scenario:
  1. A transaction rolls back after taking an outbox id. This leaves a gap: an `inTx` 40001/40P01 retry, an `afterOutbox` failure, or an in-flight transaction killed during a deploy restart.
  2. Rows after the gap are cut and delivered as update_ids N..N+k. The bot acks them with `offset=N+k+1`, and the rows are deleted.
  3. The process restarts (every continuous deploy) or a pass hits a transient DB error.
  4. The rows are re-read, find no conflict, and are inserted again under **new** update_ids. The bot sees `/pay`, `/approve` or a callback a second time.
- The report's claim that "the consumer re-reading from an old cursor creates no new updates" only holds while the rows are still unacknowledged. The test does not cover the acknowledged case.
- **Fix**: keep acknowledged rows as tombstones until `expires_at`, e.g. `ALTER TABLE bot_updates ADD acked boolean NOT NULL DEFAULT false`. Ack becomes `UPDATE … SET acked = true WHERE update_id < $2`, `read` filters `NOT acked`, and `cleanup` keeps deleting by `expires_at`. The replay window (≤ 30 s plus one batch) is far shorter than both TTLs, so tombstones close the hole. Add a test: cut, ack, reset `loaded`, CatchUp again, expect no new rows.

### H2. One bad outbox row stops update delivery for every bot
- `botupdates.go:203-205`: `s.chat.BotUpdates(ctx, all)` returns an error, and the whole pass rolls back. The next tick re-reads the same batch and fails again. `CatchUp` stays stuck at that cursor forever (the log fills with `bot update consumer failed` every second), and no bot in the tenant receives anything.
- Errors that a single row can trigger: `decodeStored` on a corrupt or unknown log payload (`chat/bots.go:565-569`, `:592-596`), `renderMessages` failing on one message's content, or `payloadOf`/`json.Marshal` (`botupdates.go:290-293`).
- **Fix**: isolate per outbox row. Compute `BotUpdates` row by row, or retry a failed batch row by row. Log and skip a row that fails N times (keep a counter in memory, or a `bot_dead_updates` table). Never let a single row pin the cursor.

## Medium

### M1. Duplicate `message_edited` from server-side rewrites of a previously edited message
- The filter at `chat/bots.go:662-666` skips server edits only when `m.EditDate == nil`, and it reads the **current** row rather than the event.
- `rewriteMessage(..., markEdited=false)` keeps the old `edit_date` (`messages.go:625-626`). It still emits `kindMessageEdit` (`:647`) from the link-preview attach (`messages.go:607`, triggered after `EditMessage` by `fetchLater` at `:728`) and from media processing (`media.go:386`).
- Scenario: a user edits a message to add a link. The bot gets one `message_edited` for the edit and a second, identical one when the preview arrives.
- **Fix**: carry "user-visible edit" on the event, e.g. `UpdateMessageEdit` gains an internal `server_side` flag set when `!markEdited`, and the consumer skips it. Alternatively, compare `edit_date` against the outbox row's `created_at` (skip when `edit_date < row.CreatedAt - ε`).

### M2. N+1 queries in the consumer, run inside the cursor-locked transaction
- `chat/bots.go:647-684`: each ref calls `renderMessages` (several queries), `botChat` (`memberRow` + `loadUsers`) and `mergeUsers`.
- `chat/bots.go:763-797`: each callback runs `loadMessages`, `loadChats`, `renderMessages`, `botChat` and `loadUsers`.
- With `passBatch = 500` in a busy group that has two bots, that is roughly 5 × 1000 serial queries per pass. They run while the `outbox_cursors` row lock and the pass transaction are held, which delays the next Kick and the long-poll wake-ups, and the cost grows with the number of bots.
- **Fix**: batch it. Render all messages per chat in one `renderMessages` call per viewer bot, load `botChat`/member rows once per (chat, bot), and load presser users in one `loadUsers`.

### M3. The failed-auth block also refuses valid tokens from a shared IP; the nginx per-IP limit undercuts the tiers
- `botapi/botapi.go:265-270` checks `isBlocked(ip)` **before** authenticating. Any client behind the same egress IP can send 20 bad tokens (shared NAT, the same VPS host, or a CI runner) and lock out every legitimate bot on that IP for 60 s, then repeat. Smaller-scale versions of the same thing: a bot left running with a revoked token blocks its own sibling bots.
- `infra/chat/nginx/chat.hoandat.com.conf` (`limit_req_zone … rate=50r/s` keyed on `$binary_remote_addr`): every bot on one host shares 50 r/s, which is below the `internal` tier (500 calls/s) and the `verified` tier (100/s) promised in the spec and in `botapi.go:65-78`.
- **Fix**:
  - Authenticate first and apply the IP block only to requests that fail authentication. A valid token bypasses the block, but its failures still count.
  - Optionally key failures by `(ip, bot_id prefix)`.
  - Either raise the nginx zone, or document that tiers above 50 r/s need a dedicated egress IP.

## Low

1. **Bot churn and username squatting**: `botadmin.go:299-357` has no rate limit on `CreateBot`, and `DeleteBot` (`:451-475`) keeps the `users` row, so the username is reserved forever. One reauth covers 10 minutes of deletes, so an owner can create and delete without bound, permanently burning `*bot` usernames and growing `users`. Add a per-owner create rate limit (e.g. `limitCreate`), or release the username on delete (rename to `deleted_<id>`).
2. **A deleted bot still looks alive to users**: `ResolveUsername`/`SearchUsers` (`chat/users.go:364+`) still return it with `is_bot`; `CreatePrivate` plus sending to it succeeds and records consent (`checkPrivatePeer`, `chat/bots.go:79-80`), but nobody receives the message. `StartBot` returns 404 `bot`. Refuse posts to a deleted bot in `checkPrivatePeer` (`bots.deleted_at`), or hide deleted bots from resolve and search.
3. **Spec/code mismatch on `&` in HTML mode**: `format/html.go:63-67` rejects any `&` that does not start a valid reference ("AT&T" gives a 400). `spec/bot-api/format.md` says `&` must be escaped only "when it could read as a reference". Align one with the other; strict parsing is fine, but then the doc should say "always".
4. **Method errors differ between nginx and the app**: `limit_except GET POST PUT { deny all; }` in nginx answers 403 with an nginx HTML body, while the app answers `405 method_not_allowed` in the JSON envelope (and the spec lists that code). Drop `limit_except` (the app already enforces methods), or document the 403.
5. **Spec gaps**: the `unavailable` 503 (`botapi.go:206-208`) appears in the code examples, but no operation lists a 503 response. Several operations can return `429` with `retry_after` 60 from the auth block; the description should mention it.
6. **Busy loop during shutdown**: after `ReleasePolls`, every new `Poll` returns at once (`botupdates.go:432-434`), so bot clients spin during the 70 s drain until the call limiter answers 429. Low impact; alternatively return 503 `unavailable` with `Retry-After`.
7. **Part numbering depends on state at cut time**: `parts[key]` (`chat/bots.go:678-683`) numbers the surviving refs of one outbox row. If one message of a multi-message row (a forward batch) is deleted between the first cut and a replay, the numbering shifts and the `(bot_id, outbox_id, part)` dedupe may drop or duplicate one message. Key on `seq` instead: `UNIQUE (bot_id, outbox_id, kind, seq)`.
8. **Migration lock**: `ADD CONSTRAINT users_idp_sub_unless_bot CHECK …` validates the whole table under ACCESS EXCLUSIVE, inside goose's transaction, with no `lock_timeout`. This is fine at the current table size. For future large tables, consider `NOT VALID` followed by `VALIDATE CONSTRAINT`, plus `SET lock_timeout`.
9. **StartBot side effect outside the transaction**: `StartBot` records consent before `SendMessage` and outside its transaction (`chat/bots.go:140`), so a failed send (rate limit or restriction) still leaves consent recorded. This is harmless (the user did intend to start the bot), but it differs from the documented "start = consent + /start" atomicity.
10. **Callback updates render deleted messages**: `botCallbackUpdates` renders the message even when `m.Deleted` (`chat/bots.go:774`), unlike the message path. Skip it, or render it as deleted, to be consistent.

---

## Checked and found OK

- **Token**: 40 characters from a 64-symbol alphabet via `crypto/rand` + `rand.Int` (unbiased, about 240 bits). Only SHA-256 is stored, with a `CHECK octet_length = 32`. `subtle.ConstantTimeCompare` is used. The parse regex and the `< 2^53` id check are in place. A reset invalidates the old token immediately (single column). Delete clears `token_hash`. The token never appears in logs (`Authenticate` errors log at most `bot_id`, and pgx errors carry no args).
- **Tenant isolation**: `onTenantHost` limits the API to the `PublicOrigin` host (with port 80/443 tolerated), so the media host gets 404. Every bot query filters `tenant_id`, and the process serves a single tenant. nginx passes `Host $host`.
- **Client IP**: `X-Real-IP` is trusted only from a loopback peer, nginx sets it from the Cloudflare real-IP `$remote_addr`, and the Cookie header is stripped while Set-Cookie is hidden.
- **nginx logging**: the `chat` format logs only `$uri`; Authorization is never logged; callback ids in the path are not secrets.
- **Request size**: the app caps bodies at 1 MiB via `LimitReader` and nginx sets `client_max_body_size 1m`. Unknown fields are rejected, trailing data is rejected, and Content-Type is enforced.
- **Long poll timeouts**: server `WriteTimeout` is 60 s against a 50 s maximum poll, and nginx `proxy_read_timeout` is 65 s. `/updates` is exempt from the 15 s request timeout.
- **Consent invariant**: enforced in `checkPrivatePeer`, which every `postable` path calls (text, media, forward; bots only reach `postText`). Bot-to-bot needs consent from the reverse direction, which is never recorded. Blocks still apply after consent. A bot cannot post into a private chat it is not a member of (`activeChatFor`). The Bot API has no private-chat creation. Secret chats are not implemented in the core (`CHAT_TYPE_SECRET` is render-only). A bot removed from a group fails membership on send.
- **Privacy mode**: the bot's own messages and other bots' messages are dropped (`botAuthors`). Groups with privacy mode keep only service messages, replies to this bot, and `/cmd` or `/cmd@thisbot`. `visible_from_seq` is respected. Edits are re-filtered against the current text. The wire `Message` exposes `reply_to_seq` but not the replied-to content, and wire `User` carries no email.
- **PressInlineButton**: requires active membership, `mem.sees(msg)`, a live bot author that is still a member, and an exact `callback_data` match against the stored button. Consent is recorded only for private chats. The callback id is 16 random bytes. `Answer` is scoped to `bot_id` and limited to once within 15 minutes. `AwaitAnswer` reads the database first (no lost-wakeup race) and its map entry is cleaned up in a defer.
- **Reauth**: a missing `auth_time` (zero) is refused, not treated as fresh. `auth_time` comes only from a verified ID token at the code exchange; refresh does not update it, and `user_sessions` is inserted in only one place. Getting a fresh value requires `prompt=login` plus credentials at the IdP. An old session cannot pass.
- **Link URLs**: Markdown and HTML both go through `entities.IsAllowedURL` and are validated again in `validateText`. Button URLs and answer URLs use the same allowlist.
- **update_id single writer**: `bots` rows are locked in id order with `FOR UPDATE … deleted_at IS NULL`, and `next_update_id` advances only on an actual insert. `DeleteBot`, `UpdateBot` and `ResetBotToken` each lock a single `bots` row, so there is no lock-order cycle. `passMu` serializes passes in-process, and the cursor row lock serializes them across processes.
- **Kick/sweeper**: `commitObserver` only wakes the consumer without blocking. The bot consumer is independent of the dispatcher and sweeper, and the outbox `inline_button` row is written in the same transaction as `bot_callbacks` (`afterOutbox`).
- **Long poll**: a newer poll closes the older one's `superseded` channel and the older poll returns 409. No goroutines are spawned, timers are stopped, and the polls map is cleaned up in a defer. Wake channels are bounded at one per bot.
- **Migration 0013**: expand-only. `ADD COLUMN … DEFAULT false` is metadata-only. Dropping NOT NULL on `idp_sub` is compatible with `users_tenant_idp_sub_key` because NULLs are distinct. The cursor is created at `max(outbox.id)` with ON CONFLICT DO NOTHING, and `lockCursor` creates it the same way if it is missing. The down migration backfills a placeholder sub before restoring NOT NULL. The old binary reads `idp_sub` only via `store.scanUser` on its own session user or IdP upserts, never for a bot, so a binary-only rollback is safe.
- **UpsertIdPUser**: still inserts a non-null sub. An ON CONFLICT with no target also retries on a clash with a bot username. `userColumns` coalesces `idp_sub`.
- **`is_bot` rendering**: set in `loadUsers`/`render`, which covers every chat-core user path, and in the bot renders. `selfUser` is never a bot.
- **Proto**: `bot_admin.proto` is new. `GetBotInfo`, `GetBotInfoRequest/Response` and `PressInlineButtonResponse.timed_out = 4` are purely additive.
- **OpenAPI vs handlers**: the paths, methods, query bounds (offset 0..2^53-1, limit 1..100, timeout 0..50), envelope, error codes, Update shape (`update_id` + one kind key), Callback (`id, from, message, data`) and SendMessage fields all match `wire`/`botapi`. The exceptions are Low 3-5.
- **ADR 0010**: the host table in the working tree is already updated to put `/bot/v1/` and `/hook/` on `chat.<d>`, so open item 1 of the developer report is partly done (`plan.md` is not checked).

## Recommended actions (in order)
1. H1: acknowledged rows become tombstones, plus a test that replays after an ack.
2. H2: isolate per row, with skip-and-log for poison rows.
3. M1: skip server-side `message_edited`.
4. M3: authenticate before the IP block; reconcile the nginx 50 r/s with the tiers.
5. M2: batch rendering in the consumer.
6. Low 1-2 (bot churn, deleted-bot UX), then the doc and spec alignment (Low 3-5).

## Unresolved questions
- Is `chat-api` guaranteed to stay a single instance? The 409 poll semantics and the in-process wake-ups assume one process; with two, a second poll on the other instance would not supersede the first.
- Should a deleted bot's username be released or reserved? This is a product decision; it affects Low 1.

Status: DONE_WITH_CONCERNS
Summary: There are no critical trust-boundary defects; tokens, tenant/host gating, consent, privacy mode, button authorization and reauth are sound. Two high-severity delivery defects in `botupdates` need fixing before real bots rely on it: a replay re-delivers acknowledged updates, and one bad outbox row stalls every bot.
Concerns: H1/H2 affect bot correctness on every deploy and under DB hiccups; M1-M3 affect correctness and fairness under load.
