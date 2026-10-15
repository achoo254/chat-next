# Code Review: 00a5264, session replacement on re-sign-in and bot last-fetch

## Scope
- Commit: 00a5264 (67 files, +1010/-80). Security focus: server/internal/auth/{routes,sessions,cookies}.go, server/internal/store/sessions.go, proto auth/bots/bot_admin, migration 0014, botadmin/botapi, packages/core start-app/map/types, apps/web bot-chat.tsx, ADR 0006.
- Verified: `go build ./...` clean; `go vet` on auth/store/botadmin/botapi clean; `go test ./internal/api -run 'TestSignInAgainReplaces|TestSignInWithoutASessionCookie' -v` 2/2 PASS (they actually ran, no skip); `go test ./internal/botapi ./internal/botadmin` ok; `go test ./internal/rpc -run TestIsNewLogin` ok. Web/core vitest not run.
- Cross-checked the IdP (hoandat-auth src/interactions/grant-builder.ts:26-41): a grant is reused per IdP session (interaction.grantId) for the same account and client, so the ADR's shared-grant premise holds.

## Overall Assessment
The trust boundary is sound. "Same browser" comes from the browser's own `__Host-` SameSite=Strict session cookie. Its hash travels inside the AEAD-sealed login cookie, and the callback only accepts that login cookie together with a matching state/PKCE. An attacker cannot name another user's or another device's session. To plant a hash they would need that session's token, and `__Host-` blocks a sibling subdomain from setting the cookie. The main residual risk is client-side: a narrow race in other tabs of the same browser can turn REPLACED into an "unauthenticated" wipe. There are no Critical or High issues.

## Critical Issues
None.

## High Priority
None.

## Medium Priority

### M1. Revoke commits before the browser has the new cookie, so other tabs can wipe local data
- server/internal/auth/routes.go:175 runs `Sessions.Replace` (commit, then the trigger emits session_revoked reason 6), and only then sets the cookie at :179 and writes the interstitial at :180.
- A second tab of the same browser (the reauth runs as a same-tab navigation in console.tsx, so the *other* tabs are the ones that see REPLACED) gets the frame. It calls `connection.reconnectNow()` (packages/core/src/app/start-app.ts:256-261) with no delay.
- Failure path: the WS handshake or any in-flight RPC (outbox send, getDifference, upload) reaches the server carrying the OLD cookie before the browser has processed `Set-Cookie`. The gateway returns 401 (handler.go: Authenticate -> ErrNoSession), which leads to `probeSession` -> getState 401 -> `sessionEnded("unauthenticated")` (start-app.ts:367, also :327/:354/:499/:668). The result is `endSession(wipe=true)`: the local DB and blob store are destroyed and the tab drops to the welcome screen, although the cookie is valid a few ms later. The DB name is per tenant+user, so the wipe also hits the database the reauth tab is opening.
- Likelihood is low (the window is roughly the commit-to-cookie-applied gap), but the outcome is unsent outbox items and drafts lost silently, which is exactly what this feature means to prevent.
- Fix (either, ideally both):
  1. Server: set the cookie and write and flush the interstitial first (`http.NewResponseController(w).Flush()`), then call `Replace` with a detached context (`context.WithoutCancel(ctx)` plus a timeout). The browser then holds the new cookie before the revoke event exists.
  2. Client: after a "replaced", run a grace window (e.g. 3 s) in which an "unauthenticated" result re-probes once after a short delay before wiping.
- Missing test: core test where the first reconnect after `replaced` gets a 401 and the second succeeds; the expectation is no wipe.

### M2. "Bot chưa chạy" banner compares the server timestamp with the client clock
- apps/web/src/messaging/bots/bot-chat.tsx:56 stamps `at = Date.now()/1000` and :80 compares it with the server's `lastUpdateAt`, using a 120 s threshold.
- The server-side write lag is at most about 30 s (throttle) plus up to 50 s (LongPollMax), so the actual slack is around 40-70 s. A client clock that runs more than about 50-70 s fast shows the banner for a running bot. A clock that runs slow hides it for a stopped one. Unsynced Windows/VM clocks drift that far often enough to matter for owners.
- Fix (recommended): compute it on the server. Add `bool not_running` (or `int64 server_time`) to GetBotInfoResponse, computed as `now() - last_update_fetch_at > 120s` in `botadmin.Info` (botadmin.go:746, owner branch only). An alternative is to use the HelloFrame `ServerTime` offset that the client already receives. Keep `last_update_at` for display.

## Low Priority

### L1. ADR 0006 and the routes.go:88 comment state a false premise
They say the IdP's redirect to the callback is cross-site. The IdP is auth.hoandat.com and the app is chat.hoandat.com, which share the site hoandat.com, so the Strict cookie *is* sent on the callback in production. The design still works (carrying the hash is harmless and robust to other IdP hosts), but the rationale text is wrong. Reword to "may be cross-site (IdP on another site), so the hash is carried in the login cookie".

### L2. Any *.hoandat.com page can trigger a silent replacement
Pages on sibling subdomains are same-site, so a top-level navigation from them to `/auth/login` sends the Strict cookie. With an IdP SSO session this rotates the user's own session without interaction. The impact is limited to the user's own session plus the M1 race; there is no cross-user effect. Fixing M1 neutralises it.

### L3. Old cached bundles map reason 6 to "unknown", then "unauthenticated", then wipe
packages/core/src/protocol/map.ts maps it now, but tabs still running the pre-deploy bundle wipe on re-sign-in. This is transient and acceptable without real users; mention it in the deploy note.

### L4. Shared-grant heuristic leaves an orphan refresh token at the IdP
sessions.go `Replace`: when either sid is empty, the grant is assumed shared, so the old RT is erased locally but stays valid at the IdP until the grant expires. It can no longer be used from chat-next, so this is acceptable and documented. It is not a replay risk: a concurrent grant check on the old session cannot write a rotated RT back, because `leaseHeld` requires `revoked_at IS NULL` (store/grant_check.go:121).

### L5. Banner refresh loop dies on the first failed fetch
In bot-chat.tsx `load`, the rejection handler is `() => undefined`, so no further `setTimeout` is scheduled. The banner then freezes until the chat is reopened. Reschedule on error as well.

### L6. `RecordUpdateFetch` costs a DB round trip on every getUpdates
botapi.go:500 makes the call even when the throttle predicate makes it a no-op, and it runs before `Poll`, synchronously. Short-timeout bots double their DB calls per poll. An in-process per-bot `lastRecorded` map (process-local throttle) would skip most of these round trips. Not urgent.

### L7. Test gaps
- No test for a different user signing in on the same browser (revokes at the IdP, and the old tab gets `user_changed` and wipes).
- No test for a login whose cookie names an already revoked or garbage session (NotFound path).
- No test that a non-owner GetBotInfo gets `is_owner=false` and `last_update_at=0`. botadmin_test changes only adapt signatures; check that one asserts the non-owner zeroing.

## Edge Cases Checked (scout)
- **Attacker revoking another user's or device's session:** not possible. The hash comes only from the request's own cookie (routes.go:90-92) and is sealed in the login cookie (cookies.go loginState.Replaces, AEAD with AAD). The callback needs that login cookie, the matching state and PKCE. `ReplaceSession` is tenant-scoped and excludes `newID` (store/sessions.go:270-281).
- **Cross-site initiated login:** a Strict cookie is not sent, so `Replaces` is empty and nothing is replaced (the old duplicate behaviour, safe).
- **Old session surviving:**
  - It survives only if Replace errors (logged Warn, routes.go:176), if the login started without the cookie, or if a different session was created between login start and callback.
  - Two concurrent logins overwrite the single login cookie, so the first callback fails its state check and no orphan is left.
  - Survival is acceptable in each of these cases.
- **Different account on the same browser:**
  - A's session is revoked and A's RT is revoked at the IdP (correct, since A's IdP session was replaced by B's).
  - A's tab reconnects, Hello.userId differs, and `user_changed` wipes A's data (correct).
- **Back-channel logout:**
  - Same sid means the new and old sessions share the grant: a later logout for that sid ends both (old already revoked, no conflict).
  - A different sid means the old sid's logout cannot hit the new session.
  - A logout landing between login start and callback revokes the old session first, so Replace returns NotFound (no-op).
- **Grant-check concurrency:** a lease on the old session racing Replace cannot persist a rotated token onto the revoked row (`leaseHeld`).
- **Engine sessionId:** reset on Hello (engine.ts:223), so the REPLACED event replayed via getDifference after reconnecting does not re-trigger a reconnect.
- **Bot last-fetch exposure:**
  - `last_update_at` appears only in `Bot.Render()`, whose callers (ListMyBots, UpdateBot, ResetBotToken, create; botadmin.go:302/369/429/459) are owner-scoped.
  - It also appears in GetBotInfo, gated by `b.OwnerID == caller` (botadmin.go:746).
  - `is_owner` leaks nothing beyond the fact that the caller is not the owner.
  - There is no webhook delivery mode for bots, so the banner is not false-positive for webhook bots.
- **Migration 0014:** nullable `ADD COLUMN`, no table rewrite, expand-only, Down provided. No index needed (looked up by PK).
- **RecordUpdateFetch locking:** the `FOR UPDATE SKIP LOCKED` subquery cannot deadlock with the update writer, and a skipped write is retried on the next poll.

## Positive Observations (risk calibration only)
- The token hash is carried in the login cookie, not the token itself, and the cookie is sealed.
- IdP revocation runs in the background (`m.background`), so the callback's latency does not depend on the IdP.
- The two new server tests ran against a real DB and assert both IdP outcomes (shared sid: 0 revoked; other sid: 1 revoked).

## Recommended Actions
1. M1: reorder the callback to cookie, flush, then Replace on a detached context; add a client grace re-probe after "replaced", plus a core test.
2. M2: server-computed `not_running` (or server time) in GetBotInfoResponse.
3. L1: fix the ADR 0006 and routes.go comment about the callback being cross-site.
4. L5 and L7: reschedule the banner refresh on error; add the different-user, NotFound and non-owner tests.

## Metrics
- Type coverage: not measured (TS typecheck not run in this review).
- Tests: Go targeted packages pass; web/core suites not run.
- Lint: go vet clean on touched server packages.

## Unresolved Questions
- Does hoandat-auth rotate the IdP `sid` on `prompt=login` for the same account? If it does, every reauth takes the "different sid" branch and revokes the old RT at the IdP. That is still safe (the grant is per IdP session), but the test's shared-sid path would then not reflect production.

Status: DONE_WITH_CONCERNS
Summary: The session replacement cannot be abused across users or devices, and the bot last-fetch data is visible to the owner only. There are two Medium issues: a revoke-before-cookie race that can wipe local data in other tabs, and the bot banner comparing against the client clock.
Concerns: M1 (reorder the callback and add a client grace period), M2 (server-computed flag recommended).
