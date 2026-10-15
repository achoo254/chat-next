# Service worker update fix: report

Status: done. All gates pass. nginx was not changed by this work, so it deploys as a normal release with no root step.

## What was actually wrong (verified against the code before the change)

- Page loads were already network-first. The old `apps/web/src/sw/service-worker.ts` `page()` did `return await fetch(request)` and used `caches.match(SHELL_PAGE, { cacheName: CACHE })` only in the `catch`. A tab opened or reloaded online therefore always got the server's current `index.html`. This matches the controller's correction: the tab was on the current bundle.
- Old-asset lookup was already across all caches. `file()` used `caches.match(request)` over every cache.
- The real defect was in `install`, which had no `skipWaiting`, while `activate` deleted every other `app-shell-*` cache. A new build's worker therefore sat in `waiting` until every tab of the origin closed. That is safe, but users who keep the app open never get the new worker.
- A second, latent problem: once old caches are retained, `caches.match(request)` searches the oldest cache first. Non-hashed files (`/manifest.webmanifest`, icons) would then come from an old build. This is now fixed: the current build's cache is checked first.

## What changed

- **Worker** (`src/sw/app-shell-worker.ts`, new; `service-worker.ts` is now a thin entry):
  - `install` caches the build, then calls `skipWaiting()`. A new install also replaces a worker that is already `waiting`, so users stuck on today's waiting prod worker are taken over on their next update check, without closing tabs.
  - `activate` only calls `clients.claim()`. Pruning is deliberately not done there, because activation holds back every fetch.
  - Navigations stay network-first, with this build's cached shell used offline. `/assets/*` stays cache-first: this build's cache, then any kept build's, then the network (with cache-on-fetch).
- **Retention and pruning**:
  - Each build is named by its entry script, `/assets/index-<hash>.js`. `vite-service-worker.ts` reads it from `index.html` and compiles it in, and the page finds the same `<script type=module src>` in the DOM.
  - When a tab asks the worker for its build, the worker answers, then asks every window client the same question over a `MessageChannel` (1.5 s timeout). It then deletes every previous cache that no answering tab needs.
  - Tabs that don't answer (today's prod code, frozen tabs) are "unknown". While any exist, the newest 3 previous caches are kept as well (`MAX_UNKNOWN_KEPT`, about 3.5 MB each). The pure decision is `cachesToDelete` in `shell-routes.ts`.
- **Page** (`register-service-worker.ts`):
  - It answers the worker's build questions.
  - On `controllerchange` it asks the new controller for its build. If the tab already had a controller and the answer differs from its own entry, it marks an update. It does not mark one on the first takeover of an uncontrolled tab, or when the worker is silent (an old worker or the kill switch).
  - Long-open tabs also call `registration.update()` hourly, and when the tab becomes visible if 15+ minutes have passed. This was added because otherwise a single long-open tab never learns about a deploy.
- **UI**:
  - `components/update-bar.tsx` shows "Đã có bản mới · Tải lại" (en: "A new version is available · Reload"), rendered app-wide in `App`.
  - Clicking calls `location.reload()`. There is no automatic reload.
  - Styled in `app.css`: a floating pill like the toast, raised above the composer.
  - The mock came first: `mockups/chat.html#connection-states` has a new paragraph and frame.
- **Docs**: in `docs/deployment-guide.md`, the old "waits for all tabs" sentence was replaced and a new "Service worker: cập nhật" section was added. It covers the behaviour, retention, the bar, rollback to a pre-fix release (that worker waits again, which is harmless) and a post-deploy check command. The kill switch and the `location = /sw.js` rules are unchanged and still valid. The kill switch has no message handler, so tabs show no bar under it.

## Tests and gates

- Unit tests:
  - `test/app-shell-worker.test.ts` runs the worker against an in-memory CacheStorage and fake tabs. It covers skipWaiting/claim, old-cache retention for lazy chunks, pruning by tab answers, unknown-tab retention, the network-first page with offline shell, current-build-first files, cache-on-fetch, and leaving server endpoints alone.
  - `test/app-update.test.tsx` covers the update decision cases, the build answer, the entry lookup, and the bar rendering and click-to-reload.
  - `test/service-worker.test.ts` has `cachesToDelete` and entry-detection cases added.
- E2E: `test/e2e/sw-update.e2e.ts` builds two production releases (the second with changed code, so the entry and lazy chunk get new names). It serves them with a small server that follows the nginx rules, on port 4710.
  - Steps covered:
    - The open tab shows the bar.
    - A tab opened after the deploy shows none, and there is no auto-reload.
    - The old tab still fetches its old lazy chunk (200 from the cache) while the server returns 404 for it.
    - "Tải lại" loads the new entry, and the old cache is pruned down to 1 cache.
    - With the server stopped, a reload opens the new build from the cache.
  - Mutation check: with `skipWaiting` removed, this e2e fails (the bar wait times out after 30 s).
- Gate results:

  | Gate | Result |
  |---|---|
  | `pnpm lint` | exit 0, 0 warnings, check-brand clean |
  | `pnpm typecheck` | all packages Done, exit 0 |
  | vitest (apps/web, `--maxWorkers=2`) | 35 files and 352 tests passed |
  | `pnpm perf` | all budgets met; startup JS 147.3 KB of 150 (was about 146.5); startup CSS 17.1 KB of 20 |
  | `pnpm e2e` | 25 of 25 passed, including the new scenario |
  | gitleaks 8.30.1 | no findings on every changed file |

## Files changed by this work (commit by path)

- apps/web/src/sw/app-shell-worker.ts (new)
- apps/web/src/sw/build-messages.ts (new)
- apps/web/src/sw/service-worker.ts
- apps/web/src/sw/shell-routes.ts
- apps/web/src/register-service-worker.ts
- apps/web/src/components/update-bar.tsx (new)
- apps/web/src/app.tsx
- apps/web/src/i18n/vi.ts
- apps/web/src/i18n/en.ts
- apps/web/src/styles/app.css
- apps/web/vite-service-worker.ts
- apps/web/test/service-worker.test.ts
- apps/web/test/app-shell-worker.test.ts (new)
- apps/web/test/app-update.test.tsx (new)
- apps/web/test/e2e/sw-update.e2e.ts (new)
- docs/deployment-guide.md
- plans/dattqh/261013-0448-chat-platform-v1/mockups/chat.html

`infra/chat/nginx/chat.hoandat.com.conf` is modified in the working tree, but by the Bot API session (`location ^~ /bot/v1/messages:send`), not by this work. Do not attribute it to this commit. If it ships in the same deploy, that deploy needs root for the nginx change.

## Concerns

- Prod tabs running today's code don't answer build questions. Until they reload, the worker keeps up to 3 previous caches for them. Those tabs also have no bar code, so they only pick up the new build on their next reload, which network-first already serves correctly.
- The waiting-worker takeover relies on standard browser behaviour (a newly installed worker replaces the waiting one, then skipWaiting activates it). The e2e covers the new-to-new takeover. It does not run today's exact prod `sw.js` as the "old" worker.
- The bar sits at the same bottom-centre spot as the toast. A toast briefly overlaps it while it is visible.
