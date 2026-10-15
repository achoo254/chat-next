# Loader UX fixes, bot username, empty pane, section headings

Status: DONE_WITH_CONCERNS (all gates green; concerns below). Not committed, nothing deployed.

## Outcome

1. **One delayed loader per screen (Jev 0.99 delay_and_merge, 0.68 idle prefetch).** In-app screens now open in 10–20 ms with no loader on a normal connection. A loader appears only after 320 ms of waiting, stays at least 400 ms, and the code and the data of a screen load in parallel under one loader. On a full reload the index.html splash stays up until the first screen is ready, so there is never a second loader. The code of Cài đặt, Developer Console, Webhook and Danh bạ is prefetched once the browser is idle after startup.
2. **Create-bot username (Jev 0.97).** The username is normalized while typing (Vietnamese folded with the existing `fold` from `@app/core`, so đ becomes d; lower case; spaces and dashes become `_`; other characters are dropped). It is suggested from Tên hiển thị plus `_bot` until the user edits it ("Deploy Thử" → `deploy_thu_bot`, verified in the browser). The uniqueness check and the alternative suggestions are unchanged.
3. **"Chọn một cuộc trò chuyện" is vertically centred** in the middle pane (and so is the "not found" pane state).
4. **Section headings are no longer UPPERCASE.** They are now small bold sentence case (13px/600, muted) across the app and in the mocks. Badges and chips (`.tag`, `.sev`, `.flag-label`) keep their caps because they are not headings.
5. "Developer Console" is unchanged (Jev 0.52).

## Shared mechanism (no per-screen hacks)

- `apps/web/src/components/loader-gate.ts` holds the pure timing state machine (`LoaderGate`) and the splash cover:
  - the delay is 320 ms: 20 ms past React's 300 ms Suspense reveal throttle, so a load that React commits at 300 ms never races the loader;
  - once shown, a loader stays at least 400 ms;
  - loaders that take over from one another in the same commit share one wait and one time on screen;
  - while the splash is up, a gate holds the splash instead of drawing its own loader.
- `apps/web/src/components/delayed-loader.tsx` provides:
  - `LoaderBoundary`: Suspense for code, with one delayed fallback per region; content that arrives while that loader is visible waits out the minimum time;
  - `useLoader(loading)`: an in-place loader that keeps its minimum time;
  - `DelayedLoader`;
  - `Ready parts`: holds a screen back, the first time it shows, until its code and data are in. It uses state rather than Suspense, so content shows as soon as it arrives instead of at React's 300 ms reveal;
  - `LoaderScope`.
- `apps/web/src/components/preload.ts` provides:
  - `preloadable(load)`: lazy code that can be fetched ahead and, once loaded, renders synchronously;
  - `resource(owner, key, fetch)`: one request shared by the route that starts it and the screen that reads it. A result is read by one screen visit and dropped after its reader unmounts; an unread result is dropped after 10 s;
  - `useLoad(resource)`: the first result from the resource, retries in place, never suspends;
  - `prefetchWhenIdle` (`requestIdleCallback`, falling back to a 2 s timer).
- Where each route starts its code and data together:
  - `messaging-root.tsx` (`screenParts`) for settings tabs, the console and moderation;
  - `chat-screen.tsx` for the webhook list and detail, plus the contacts store load.
- Data resources: `messaging/data/screen-data.ts` and `screens/settings/sessions-data.ts`.
- Every in-panel `BrandLoader` now goes through this mechanism:
  - settings-extra (privacy, blocked, notifications) and sessions;
  - console list, bot page and moderation;
  - hook list and hook detail, integrations page and chat admin;
  - banned list and contacts;
  - conversation and message list (which share one `LoaderScope`).
- `BrandLoader` locks every loader to one animation clock (`--loader-phase`) and passes on its time on screen (`--loader-age`), so a hand-over in place does not restart the dots. `PageLoader` holds the splash; CSS now hides the splash with `#splash[hidden]` instead of `#root:not(:empty) ~ #splash`.

## Loader timeline (Playwright, e2e stack, MutationObserver on `role=status` loaders)

"empty frame" is the still, unannounced placeholder; "LOADER SHOWN" is a visible logo loader. The in-app runs happen after idle prefetch, so the code is already in.

### 1333x780

```
sign-in landing (full load of /)        5 ms SHOWN splash → 374 ms HIDDEN            (one loader)
in-app, normal network (no loader at all; frame → content):
  Quyền riêng tư tab      7433 frame → 7444 content   (11 ms)
  Phiên đăng nhập tab     8959 frame → 8978 content   (19 ms)
  Developer Console      10494 frame → 10502 content  (8 ms)
  Webhook (hooks)        13588 frame → 13595 content  (7 ms)
  Cài đặt, Tạo bot, Danh bạ, Chats: no frame, no loader
in-app, +450 ms latency per request:
  Developer Console      navigate 18210 → SHOWN area(shell) 18535 (+325) → HIDDEN 18940 (405 on screen)
  Cài đặt > Thông báo    20508 frame → 20518 content, no loader (store had it)
  Webhook                navigate 22039 → SHOWN area(admin-page) 22384 (+345) → HIDDEN 22784 (400 on screen)
  Developer Console      navigate 24794 → SHOWN area(shell) 25124 (+330) → HIDDEN 25522 (398 on screen)
full reload /console              12 SHOWN splash → 377 HIDDEN (content in at 376; frame under the splash only)
full reload /settings/privacy     15 SHOWN splash → 389 HIDDEN
full reload /c/11/admin/hooks      9 SHOWN splash → 455 HIDDEN
```

### 390x844

```
sign-in landing                   5 SHOWN splash → 348 HIDDEN
in-app normal: privacy 14 ms, sessions 7 ms, console 7 ms, webhook 7 ms frame→content; no loader
in-app slow: console +324 → shown 401 ms; webhook +343 → shown 402 ms; console again +324 → shown 402 ms; notifications no loader
full reload /console 15 → 385; /settings/privacy 11 → 384; /c/12/admin/hooks 8 → 459 (splash only)
```

Every navigation shows at most one loader appearance; loads under 320 ms show none. Before this change, in-app navigations showed the empty frame for about 300 ms, because React held back the Suspense reveal. Moving data off Suspense (`Ready` and `useLoad`) removed that delay.

**Horizontal scroll** was checked at both sizes on `/`, `/settings/profile`, `/settings/privacy`, `/console`, `/console/new`, `/c/:id/admin/hooks`, `/contacts` and the empty conversation. In every case `doc scrollWidth == clientWidth` and no element scrolls sideways.

Screenshots were checked by eye: the webhook loader is centred in the admin column; the empty conversation is centred; the info panel headings read "Thành viên · 1" and "Link mời" in 13px/600 with `text-transform: none`; at 390 the create-bot form shows `@deploy_thu_bot`. They are in the session scratchpad, not the repo.

## Gates (sequential, one heavy job at a time)

| Gate | Result |
|---|---|
| `pnpm lint` | 0 errors, 0 warnings; check-brand passes |
| `pnpm typecheck` | 0 `error TS` |
| `pnpm test` (run as `pnpm -r --workspace-concurrency=1 test`; web vitest config caps workers at 2) | 11 + 761 + 17 + 288 = 1077 tests, all pass |
| `pnpm perf` | all budgets met; startup JS 144.7 KB gzip (baseline 141.7, budget 150); startup CSS 16.6 KB; laptop open chat p50 18 ms / p99 32 ms |
| `pnpm e2e` | 17/17 pass; ports 4600/4610/4630/5173 freed afterwards |

The perf build also prints a non-blocking warning: "Some chunks are larger than 500 kB after minification". It was already there before this change.

New unit tests:
- `test/loader-gate.test.ts` (9 tests, hand-driven clock): delay, minimum time, takeover continuity, Suspense content wait, splash hold and hide.
- `test/delayed-loader.test.tsx` (8 tests, fake timers):
  - empty frame for a short load;
  - minimum time once shown;
  - one continuous loader for code then data, counted with a MutationObserver;
  - Suspense hold;
  - `Ready` shows a screen at 80 ms with no loader, and shows a loader for slow parts.
- `test/preload.test.tsx` (11 tests): sharing, settled errors, retain and drop, unread expiry, `useLoad` first result, reload and update, sync render of preloaded code, retry after a failed fetch, idle prefetch and its timer fallback.
- `test/bots.test.tsx`: `normalizeUsername` and `usernameFromName` cases, plus the create flow asserts the auto-suggestion and that it stops after a manual edit.

## Mocks (updated first as the spec)

- `auth.html#loading`: the description now gives the timing rules (no loader under ~300 ms, at least 400 ms once shown, one continuous loader per screen with code and data in parallel, splash until the first screen is ready, idle prefetch, tab loader under the tab heading).
- `console.html#create-bot`: the text describes normalization and auto-suggest; the demo script normalizes, follows the name, and computes the suggestions.
- Headings are sentence case in `assets/mock.css`, `chat.html`, `media.html`, `settings.html`, `moderation.html`, `search.html` and `mobile.html`.

## Concerns

- **Startup JS grew by 3.0 KB gzip** (141.7 → 144.7; the budget of 150 is unchanged). The cost is the loader and preload mechanism plus the route preload table. I kept the contacts store out of startup with a dynamic import, which saved 1.2 KB.
- **First entry to a Shell screen no longer draws its header before the data arrives.** The whole screen appears at once, as Jev specified. Tab switches inside Cài đặt and list → bot page keep the header and use an in-place loader under it, as in the mock's "Phiên đăng nhập" frame.
- **I changed `test/setup.ts` so the idle prefetch never runs in jsdom** (`requestIdleCallback` never fires). Otherwise modules would load at a random point inside a test. The prefetch itself is covered by `preload.test.tsx`.
- **I found one root cause while debugging two failures** (`messaging.test` "Quản lý kênh page" and `messaging-redesign` "@ mention jump"). A `setState` in the layout phase forced a synchronous render, which hurried unrelated store updates. I fixed it at the source (`useGateIn` re-renders only when visibility changes). Both tests are unchanged and pass.
- The "Chọn một cuộc trò chuyện" empty pane has no mock frame, so the centring was changed in code only.

## Unresolved questions

None blocking. If the extra 3 KB of startup JS should be clawed back, the next candidate is moving `screenParts` and the console/settings resource helpers into a lazily loaded module. That would cost one more round trip on the first navigation to a secondary screen.
