# Revert multi-tab build handover; chunk GetUsers; deflake webhook retry test

Status: done, uncommitted on main (working tree). Tier: M.

## 1. Handover removed, peer fallback kept

The handover pieces of 6f67257 are restored byte-for-byte to 6f67257^ (`git checkout 6f67257^ -- <file>`), then M1 is applied on top:

- apps/web/vite.config.ts, apps/web/src/vite-env.d.ts: `__APP_BUILD_TIME__` gone.
- apps/web/src/messaging/data/web-client.ts: `build:` option removed (the only handover line in that file).
- packages/platform-web/src/{client,leader,protocol,sqlite-worker}.ts: identical to 6f67257^.
- packages/platform-web/src/tab-hub.ts and test/tab-hub.test.ts: 6f67257^ plus M1 only (`git diff 6f67257^` shows 10 + 12 lines).

Kept from 6f67257: the store's `fetchUsers` fallback (store.ts), messaging-root.tsx wiring, and the assistant-chat tests.

M1: a leader now answers a `call` with an unknown method or non-array args with `{type:"result", ok:false, error:{name:"Error", message:"unsupported method"}}` instead of dropping it. A follower's promise rejects with "unsupported method". New test: "answers a method it does not know instead of leaving the caller waiting".

L2: GetUsers is chunked to at most 200 ids, the server limit (server/internal/chat/users.go getUsersMax).
- packages/core/src/sync/engine.ts: a new private `getUsers` helper is used by `fetchUsers` and by `fetchMissingEntities` (the same unbounded call during update batches).
- apps/web/src/messaging/data/store.ts: the `fetchUsers` fallback loops in chunks of 200 and applies each chunk as it arrives.
- packages/core/test/support/fake-server.ts: the fake now rejects more than 200 ids with InvalidArgument, like the real server.
- Tests: private-chat-peer.test.ts asks for 450 users and expects 3 GetUsers calls. New apps/web/test/store-fetch-users.test.ts checks 450 missing users with every request at most 200. I confirmed that both tests fail when the limit is raised to 1000.

## 2. Flaky TestRetryBackoffAndRetryAfter

The CI log shows `webhook_test.go:399: no webhook request within 10s` at 13.46 s, which is about 3.4 s of retries plus the 10 s wait.

Cause: the test receiver sends a delivery to the test (`r.arrive <- d`) before it runs the handler that writes the answer. The test set `retryAfter = "120"` as soon as it read the 3rd request. If the test goroutine won the race, the 3rd answer already carried Retry-After 120, so the 4th attempt was 120 s away. That race is more likely on a slow runner with -race.

Fix: the answer now depends on the attempt it answers. An atomic request counter returns Retry-After 120 from the 4th request on. The test still checks the same things: the 1 s and 2 s backoff gaps, the 4th attempt arriving, and the stored wait of 119 to 121 s.

## Gates (local)
- pnpm lint: exit 0 (eslint, max-warnings 0; check-brand OK)
- pnpm typecheck: exit 0, 0 TS errors
- vitest --maxWorkers=2: platform-web 18/18, core 774/774, web 355/355
- pnpm perf: "all budgets met"
- pnpm e2e: 25 pass, 0 fail
- gofmt -l: none; go vet ./...: OK; golangci-lint: 0 issues
- go test -race -count=10 -run TestRetryBackoffAndRetryAfter: ok (76.8 s)
- go test -race -count=1 ./internal/botupdates/...: ok (22.5 s)
- gitleaks on changed files and on `git diff`: no leaks found

## Files
apps/web/src/messaging/data/store.ts
apps/web/src/messaging/data/web-client.ts
apps/web/src/vite-env.d.ts
apps/web/vite.config.ts
apps/web/test/store-fetch-users.test.ts (new)
packages/core/src/sync/engine.ts
packages/core/test/private-chat-peer.test.ts
packages/core/test/support/fake-server.ts
packages/platform-web/src/client.ts
packages/platform-web/src/leader.ts
packages/platform-web/src/protocol.ts
packages/platform-web/src/sqlite-worker.ts
packages/platform-web/src/tab-hub.ts
packages/platform-web/test/tab-hub.test.ts
server/internal/botupdates/webhook_test.go
