# Code review: e6481ab — bot webhook delivery + QA batch (SW, offline-self)

Date: 2026-10-15. Read-only review. Commit: `feat(bots): webhook delivery; offline app shell and QA fixes`.

## Scope
- Server: `internal/safehttp`, `internal/botupdates/{dispatch,webhook,botupdates}.go`, `internal/botapi/{webhook,botapi}.go`, `internal/rpc/{bots_service,interceptors,users_service}.go`, `internal/botadmin`, `internal/chat/bots.go`, `internal/profile`, `internal/linkpreview/fetch.go`, `migrations/0015_bot_webhooks.sql`, `spec/bot-api/openapi.yaml`, `docs/bot-api/README.md`.
- Web: `src/sw/*`, `vite-service-worker.ts`, `register-service-worker.ts`, `api/offline-self.ts`, `api/get-self.ts`, `app.tsx`; nginx `infra/chat/nginx/chat.hoandat.com.conf` (for the SW cache path).
- Checks I ran: `go test ./internal/safehttp/` passed. `vitest run` on service-worker, offline-self and get-self passed (3 files, 13 tests). I did not run the botupdates or api packages, which need embedded Postgres. I did not need them to confirm any finding.

## Overall
safehttp is solid. It checks the address when it dials, connects to the IP it checked, checks again in `Control`, ignores proxy settings, follows no redirects and verifies TLS. The ordering, retry and dead-letter logic is coherent, and the at-least-once behaviour is documented. Reply-in-body runs the same `send` path as the bot's own call. The service worker's route rules are conservative. There is one trust-boundary gap: the ADR 0006 recent sign-in check is missing on the new webhook RPC. The other findings are resource limits, scaling and doc accuracy.

## Critical
None found.

## High

### H1. SetBotWebhook skips the recent sign-in check that guards token reissue (ADR 0006 bypass)
- `server/internal/rpc/bots_service.go:186-203`: SetBotWebhook only checks `Owned`. ResetBotToken and DeleteBot pass `sess.AuthTime` into `requireRecentSignIn` (`botadmin.go:174`, `:464`, `:496`).
- What the webhook gives the caller is close to what the token gives:
  - Every update of the bot goes to a URL the caller chooses. That includes private messages users send the bot and group messages.
  - With reply-in-body (`botapi/webhook.go:153-209`), the caller can send `sendMessage` as the bot to every chat the bot is in.
- Failure scenario: someone with a stolen or unlocked web session cannot reissue the token, because that needs a sign-in within the last 10 minutes. They can still, without that sign-in:
  1. Set the webhook to `https://attacker.example/x`. A new secret is optional (RPC path, `webhook.go:191`).
  2. Read all of the bot's traffic and post as the bot.
  3. Keep doing it until the owner notices.
- DeleteBotWebhook with `drop_pending` and DiscardBotDeadLetters destroy data, but are lower risk.
- Fix: in SetBotWebhook, call `s.bots.requireRecentSignIn(sess.AuthTime)`. Owned already checks ownership; it could become a `botadmin.SetWebhookGate(owner, authTime, botID)`. The Console reuses the existing `reauth_required` flow. Optionally gate DeleteBotWebhook only when `drop_pending=true`.
- This is a policy choice that matches ADR 0006's intent, so confirm with Jev. My recommendation is to add the gate.

## Medium

### M1. A reply body can be 1 MiB and nothing caps total concurrency or memory across bots
- `dispatch.go:40` sets `replyMax = 1<<20`. Each bot can have up to 100 requests in flight (`MaxConnectionsMax`), and there is no limit across bots (`launch` starts one goroutine per due head).
- The two allowed reply methods carry at most 4096 characters of text plus an entity list, so 1 MiB is far more than needed.
- Scenario: an owner with N bots, each with max_connections=100, answers every POST with a 2xx and a slow 1 MiB body. Peak buffered memory is about N × 100 MiB. The owner keeps it going by messaging their own bots in many chats.
- Fix: lower `replyMax` to 64 KiB. Add a process-wide semaphore on in-flight webhook requests (for example 512), so one tenant's bots cannot use all memory or sockets.

### M2. Webhooks can reach the server's own public IP and same-host vhosts
- `safehttp.PublicIP` allows <SERVER_65_IP>, the origin of every app on .65.
- Scenario: a bot sets its webhook to an `https://<name>` whose DNS points straight at .65 (a grey-cloud record of another app on the shared server). The request comes from <SERVER_65_IP> itself, so it gets past:
  - the planned "only Cloudflare IPs on 443/80" firewall (`docs/deployment-guide.md`, Bảo mật mạng);
  - any nginx `allow <server IP>` rule on other vhosts.
- TLS verification and the port list (443/80/8443) limit the damage, but the server can still be used to call itself.
- Fix: add a configurable deny list (for example `OUTBOUND_DENY_CIDRS`, default the host's own public IPs) and check it in `allowed()`. Document it in infrastructure-inventory.

### M3. Each worker polls the database every 2 s, and `heads` scans the bot's whole backlog
- `dispatch.go:256-276` runs `config` and `heads` on every loop: on wake, on every completed request, and at least every 2 s (`workerRecheck`). This happens even for idle bots, so idle cost is about N bots × 1 query/s.
- `heads` (`dispatch.go:405-411`) uses `DISTINCT ON (queue_key)` over every pending row of the bot. The `expires_at > now()` filter is not in `bot_updates_pending_idx`, so each row needs a heap check.
- Scenario: a bot whose endpoint is down builds a 24-hour backlog of about 50k rows. Every loop (several per second while requests complete) scans 50k rows.
- Fix:
  - Skip the timer recheck while the worker has nothing pending.
  - Bound the scan with a skip-scan form (a lateral `LIMIT 1` per queue, or a `min(update_id)` grouping).
  - Add `expires_at` to the index's INCLUDE, or rely on cleanup and drop the `expires_at` filter from the hot query.

### M4. No kill switch for the service worker, and the rollback note in the deployment guide is wrong
- `docs/deployment-guide.md:60` says that after a rollback "the next online page load gets the new index.html and installs that build's worker". That is false when rolling back to a release that has no `sw.js`:
  - nginx `location /` has `try_files $uri /index.html` (`chat.hoandat.com.conf:207`), so `/sw.js` returns index.html with 200 and `text/html`.
  - The browser's update check fails on the MIME type and keeps the current worker registered indefinitely.
  - That worker keeps serving the non-hashed files it cached at install (`/manifest.webmanifest`, icons, public fonts) cache-first from `caches.match` across every cache (`service-worker.ts:73`). Offline navigations get a shell for a build that no longer exists.
  - It is not dangerous today, because pages are network-first. But if a buggy worker ever ships, there is no way to get rid of it.
- Fix:
  - Add `location = /sw.js { try_files $uri =404; add_header Cache-Control no-cache; }`.
  - Keep a minimal "unregister" `sw.js` that you can deploy when needed (`self.registration.unregister()`, then delete the `app-shell-*` caches).
  - Correct the rollback paragraph.

## Low

### L1. `Retry-After: 0` (or a past HTTP date) gives zero backoff
- `retryDelay` (`dispatch.go:615-618`) floors the delay at 0.
- A 503 with `Retry-After: 0` makes 10 attempts within milliseconds and dead-letters the update almost at once.
- Fix: `max(retryAfter, retryFirst)`.

### L2. The migration takes ACCESS EXCLUSIVE locks while it scans or builds on bot_updates
- `0015:44-50`:
  - `ADD CONSTRAINT bot_updates_kind_check` validates every row under ACCESS EXCLUSIVE.
  - The two `CREATE INDEX` statements are not CONCURRENTLY, and goose runs them in one transaction.
- With 24 hours of updates this is small today. At scale, add the constraint `NOT VALID`, `VALIDATE` it separately, and build the indexes `CONCURRENTLY` (with `-- +goose NO TRANSACTION`).
- `lock_timeout` only bounds waiting for the lock, not how long it is held.

### L3. The secret carries over to a new URL
- `SetWebhook` with an empty secret on the RPC path keeps the stored secret even when the URL changes (`webhook.go:199`).
- Changing the URL to a third-party endpoint therefore sends it the secret the old endpoint trusts.
- Suggest requiring a new secret when the host of the URL changes.

### L4. The HMAC adds nothing over the secret header
- The same secret is sent in plaintext in `X-Bot-Api-Secret-Token` and used as the HMAC key. Anyone who sees one request can sign their own.
- This is fine under TLS and is documented. Optional:
  - Stop sending the plain secret header once SDKs verify the signature.
  - Change the Node example (`docs/bot-api/README.md:78`) so it compares the secret with `timingSafeEqual` instead of `===`.

### L5. Shutdown can overrun the stated budget
- The dispatcher's drain is not in the 67 s shutdown budget (`server/README.md` Dừng êm).
- Worst case is 5 s drain + 10 s `runReply` (it uses `context.Background`, so cancelling sends does not stop it) + 5 s write.
- If pm2's SIGKILL lands, the effect is only a redelivery. Either add the drain to the budget or derive `runReply`'s context from `sendCtx`.

### L6. IPv4-translated IPv6 `::ffff:0:0:0/96` (SIIT) is not blocked
- `safehttp.go:61-82`. Example: `::ffff:0:7f00:1`.
- It only matters if a translator is on the path; there is none on .65.
- One-line hardening: add the prefix to `blockedPrefixes`.

### L7. Payload can be lost between `heads` and `payloads`
- If cleanup deletes a head row between `heads` and `payloads` (`dispatch.go:451-452`), the bot receives `{"update_id":N,"<kind>":null}` once.
- The window is milliseconds. Fix: skip heads that have no payload.

### L8. A username with no ASCII letters becomes all digits
- `UsernameCandidate("", 0)` gives `"001"` (`profile.go:91-105`). For example, preferred_username `"Đạt"` reduces to the base `"t"`, which gives `"t01"`.
- The uniqueness race is still safe: the insert is `ON CONFLICT DO NOTHING` with a retry loop and a check for a concurrent sign-in (`store/users.go:108-135`).
- Purely cosmetic. If digit-only usernames are unwanted, keep the old `user` fallback when the base is empty.

### L9. Offline start trusts any non-Unauthenticated error
- `app.tsx:56-60` opens the stored user's local data on any error from getSelf other than Unauthenticated, including a 5xx from a reachable server.
- The privacy outcome is acceptable:
  - `lastSelf` only returns a user when it matches `chat:last-user`, and the core clears that key on sign-out and session end (`platform-web/client.ts:107-110`, `:150`).
  - `forgetSelf` runs on every Unauthenticated (`client.ts:98`).
  - The local DB was already on disk.
- On a shared device where the session expired server-side, a later offline start shows the previous user's chats until it reconnects. That comes with offline-first (ADR 0009); I'm noting it, not proposing a change.

## What is OK (verified)

**safehttp**
- Checks at dial time, connects to the checked literal, checks again in `Control`, so DNS rebinding is closed.
- `Proxy: nil`, so HTTP_PROXY cannot bypass the checks.
- Redirects are returned, never followed.
- TLS is always verified (`InsecureSkipVerify` is forced false).
- Rejects userinfo, fragments and non-allowed ports (checked in parse and again at dial).
- Covers IPv4-mapped (via `Unmap`), `::/96`, NAT64 `64:ff9b::/96` and `/48`, 6to4, Teredo, `0.0.0.0/8`, CGNAT (also covers Alibaba's 100.100.100.200), `fd00:ec2::`, zoned addresses, and every resolved address of a name.
- `BOT_WEBHOOK_ALLOW_LOCAL` is refused when `CHAT_ENV=production`, and `CHAT_ENV` is required.
- linkpreview: `PublicAddress` now calls `safehttp.PublicIP` and behaves the same as before (the prefix list was identical, plus the zone check). No regression.

**Dispatcher**
- Ordering: one request in flight per queue, and `done` is only processed after the DB write, so the next head reads committed state.
- Dead-lettering a head unblocks its queue. Retrying a dead letter makes it the head again (it may arrive after newer updates were delivered; acceptable).
- The `done` channel buffer (100) is at least `MaxConnectionsMax`, so sender goroutines cannot leak. Bodies are always closed.
- The circuit breaker is per bot, and requests hold no DB connection while waiting.
- At-least-once and the two-process limit are documented (`server/README.md:249,253`). pm2 runs a single fork instance, so restarts do not overlap.

**Reply-in-body**
- Runs as the bot via `admin.Live` (tenant and not-deleted checks), the same `send` checks and the same rate limit.
- Only `sendMessage` and `answerCallback` are allowed. `answerCallback` is scoped by `bot_id` (`botupdates.go:661`).
- `random_id` is derived from (bot, update), below 2^53 and never 0. Send dedupe is keyed on `(sender_id, random_id)` for 7 days, longer than the 24 h TTL, so a redelivery cannot send twice.
- It is refused once the webhook is removed.

**Secret storage**
- Sealed with sealbox on SESSION_KEY, purpose `bot-webhook-secret`, bound to the bot id.
- Never returned by the RPC, the Bot API or the Console, and never logged: the RPC interceptor logs only the error, and `decode` does not log bodies.
- The Console's `newSecret` takes 32 symbols from a 64-symbol alphabet using `crypto.getRandomValues`.

**BotAdmin RPCs and polling**
- Every new RPC checks `Owned` before touching data. Retry and discard are capped at 100 ids and filter on `bot_id`.
- Poll refuses with 409 while a webhook is set, and `read` checks again with NOT EXISTS, so there is no race window.

**GetSelf `allow_signed_out`**
- Without a session, the handler answers empty only when the flag is set and never attaches a user. Any other Authenticate error still returns Internal. There is no bypass.
- The client treats an empty `user` as Unauthenticated (`get-self.ts:126`), and that path runs `forgetSelf`.

**Service worker**
- Handles only same-origin GET requests and excludes `/rpc`, `/ws`, `/auth`, `/hook`, `/bot`, `/healthz` and `/e2e`. Media is on another origin and never touched. No API responses or PII are cached.
- Writes to the cache at runtime only for `/assets/` responses that are `ok` and `basic`. nginx `/assets/` answers missing files with `=404`, so a missing chunk cannot poison the cache with an index.html.
- Install uses `cache: "reload"`. There is no skipWaiting, and old caches are deleted on activate.
- `/sw.js` and `index.html` are served `no-cache`, and the CSP allows `worker-src 'self'`.

**Migration 0015** only adds things, keeps the previous binary working, and its Down is consistent.

**OpenAPI** matches the handlers (required secret, port list, error codes, the 409 rule, WebhookAnswer shape, the 5-minute replay window).

## Recommended actions (in order)
1. H1: gate SetBotWebhook on `requireRecentSignIn`. Confirm with Jev, recommended yes.
2. M1: lower `replyMax` to 64 KiB and add a global in-flight semaphore.
3. M2: add an outbound deny list for the host's own public IPs.
4. M4: add `location = /sw.js` returning 404 for a missing file, keep a kill-switch worker, and correct the rollback note.
5. M3: stop polling while idle, and make `heads` a bounded skip-scan.
6. L1, L3, L5, L6, L7 are small hardening changes. Do L2 before bot_updates grows.

## Metrics
- Tests run: safehttp (pass), 3 web test files / 13 tests (pass). No lint or typecheck run (read-only, targeted).
- Linting issues: not measured.

## Unresolved questions
- H1: does the product want the webhook change gated like token reissue? I recommend yes.
- M2: which other vhosts or services on .65 trust requests from the server's own IP? Answering this decides how urgent M2 is.

Status: DONE_WITH_CONCERNS
Summary: The webhook/SSRF core is sound: it checks addresses at dial time, ignores proxies, follows no redirects, and keeps per-queue order with at-least-once delivery. One High trust-boundary gap: SetBotWebhook skips the recent sign-in check that guards token reissue. Four Medium issues: reply-body memory bounds, self-IP SSRF, DB polling cost, and no service-worker kill switch.
Concerns: H1 and M2 depend on policy and infrastructure decisions; the botupdates and api DB tests were not run.
