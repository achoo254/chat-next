# App logo and branded loading

Status: DONE. Nothing committed or deployed. **No nginx/CSP change, so no root deploy is needed.** Shipping is a normal release, because the icon files and manifest sit inside `dist/` and nginx `location /` already serves them.

## What changed

**Logo (concept A, polished)**
- `brand/icon.svg` is the rounded purple gradient square (#8874d8 to #5a47aa, derived from #6e56cf) with a white speech bubble and three primary-colour typing dots. The artwork is balanced on the centre of the square: the bubble body sits at y 480 and the bubble plus tail spans 224 to 800. The dots carry `class="logo-dot"` so the loader can animate them. The logo has no letters. Size sheet: `logo-sizes.png`, at 16, 20, 32, 48, 96 and 192 px, light and dark.
- `brand/icon-maskable.svg` (new) is full-bleed with the artwork at 80% scale, inside the maskable safe zone.
- `brand.config.json` and the schema gain `iconMaskable`. Both icons must now be SVG, because the in-app logo is inlined.

**Generated icons (`pnpm brand:gen`)**
- `packages/brand/src/icons.ts` defines the icon list, the manifest icons, the ICO encoder and the source hashes. `rasterize.ts` draws the PNGs with Playwright's Chromium (playwright is now a dev dependency of `@app/brand`).
- Output goes to `packages/brand/generated/icons/`: `favicon.ico` (16/32/48), `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180), and `icons-source.json`.
- A test fails when the brand SVGs change without re-running `pnpm brand:gen`. The web manifest now lists the SVG, the 192/512 "any" icons and the 192/512 maskable icons.
- Capacitor and Tauri only get config JSON; no native project exists yet, so there are no native icons to produce.

**Web wiring**
- `apps/web/vite-brand.ts` (new) replaces the old `brandHtml` plugin. It does four things:
  - fills `%APP_NAME%`, `%APP_DESCRIPTION%` and `%APP_LOGO%` in index.html;
  - injects `<link rel=icon>` for the ICO and the SVG, plus the `apple-touch-icon` and `manifest` links;
  - serves the icon files and `manifest.webmanifest` in dev and emits them in the build;
  - provides `virtual:brand-logo`.
- The visual harness config uses the same plugin.
- Verified in a built dist: `favicon.ico`, `icon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png` and `manifest.webmanifest` sit at the root, and index.html links all four.

**Loader**
- `apps/web/index.html` has a `#splash` (`.brand-loader.page`, `role=status`, `aria-live=polite`, `aria-busy`) with the inline logo. It has no inline style or script; its CSS is in `app.css`, which Vite links in `<head>` (render-blocking).
- The CSS rule `#root:not(:empty) ~ #splash { display: none }` hides the splash once React renders something.
- `src/components/brand-loader.tsx` provides three pieces:
  - `BrandLogo`: the logo, named by `brand.appName`, or decorative where the name is already written next to it.
  - `BrandLoader`: the panel variant, with an optional `page` variant.
  - `PageLoader`: renders nothing when the splash exists, so the same DOM keeps animating with no restart or jump through session check, chunk load and messaging start. It also puts the splash text in the UI language. Without a splash (tests, harness) it renders its own page loader.
- Motion: the dots bounce and fade in a 1.2 s wave, and a primary halo breathes over 2.4 s. The text fades in after 600 ms. With reduced motion the logo is static and the text still appears after 600 ms.
- The welcome screen's brand mark is now the logo.

**Mock (done first)**
- `mockups/auth.html#loading` shows the splash before and after 600 ms, the reduced-motion version, and a panel loader inside a Settings shell.
- The welcome brand mark is the logo, the loader CSS is in `assets/mock.css`, and the mockups index lists the new section.

**Docs:** the `brand:gen` and `packages/brand` rows in the README.

## Audit of loading states (apps/web/src)

| Where | Before | Decision |
|---|---|---|
| `app.tsx` boot (session check) | full-page spinner + text | **Replaced**: PageLoader (splash continues) |
| `app.tsx` Suspense for MessagingRoot | same | **Replaced**: PageLoader |
| `messaging-root.tsx` Starting (client start) | same | **Replaced**: PageLoader |
| `messaging-root.tsx` Suspense: Settings, Settings tab body, Developer Console, Moderation | spinner + text | **Replaced**: BrandLoader (panel) |
| `sessions-settings.tsx` first load | spinner + text | **Replaced** |
| `settings-extra.tsx` Privacy, Notifications, Blocked first load | spinner + text | **Replaced** (an error still shows the banner) |
| `console.tsx` LoadState (bot list, bot page) | spinner + text | **Replaced** |
| `hook-list.tsx`, `hook-detail.tsx` first load | spinner + text | **Replaced** |
| `integrations-page.tsx`, `chat-admin.tsx`, `banned-list.tsx` (chat not yet known) | lone spinner | **Replaced** |
| `banned-list.tsx` list first load | spinner + text in card | **Replaced** |
| `contacts.tsx` list first load | spinner + text | **Replaced** |
| `conversation.tsx` chat not yet known | lone spinner | **Replaced** |
| `message-list.tsx` first messages load | spinner + text | **Replaced** (`.messages[aria-busy]` kept for the perf harness) |
| `moderation.tsx` report detail and actions | text | **Replaced** |
| `chat-list.tsx` first load | skeleton + foot spinner | Kept: it is a skeleton |
| `message-list.tsx` loading older | inline spinner | Kept: "load more" |
| `conversation.tsx` status line (connecting/updating) | inline | Kept: connection status, not a load |
| `search-results.tsx` local/server status | inline status | Kept: live results around it |
| `hook-activity.tsx`, `hook-audit.tsx` | text in a sub-section | Kept: a section of a loaded page |
| `chat-admin.tsx` admins card | text in a card | Kept: other cards are already shown |
| Dialogs (pinned, member, chat, read-by, invite preview), info panel | inline note/spinner | Kept: modal-internal state |
| Media (`media-content`, `viewer`), `create-dialogs` link, kb-row, all `aria-busy` buttons | small spinners | Kept: inline/pending, as specified |
| `chat-screen.tsx`, `chat-list.tsx`, `conversation.tsx`, `message-item.tsx` Suspense fallbacks | empty layout boxes / MediaReserve (no spinner) | Kept: layout placeholders for fast chunks |

## Evidence

- `pnpm lint`: 0 errors and 0 warnings; check-brand reports "no hard-coded product name".
- `pnpm typecheck`: every package Done, no errors.
- `pnpm test` (sequential, maxWorkers 2):

  | Package | Files | Tests |
  |---|---|---|
  | brand | 1 | 11 |
  | core | 23 | 761 |
  | platform-web | 5 | 17 |
  | web | 24 | 259 |

  The new `apps/web/test/brand-loader.test.tsx` has 7 tests; the brand package has 4 new icon tests.
- `pnpm perf`: "all budgets met".
  - Startup JS is 141.7 KB of 150. Startup CSS is 16.6 KB of 20 (was about 16.2).
  - Laptop open p50/p99 is 18/25 ms; scroll runs at 60 fps with 0 slow frames.
  - The only warning is Vite's existing "chunks larger than 500 kB" notice (worker chunk).
- `pnpm e2e`: 17 pass, 0 fail. The `ws proxy ECONNRESET` lines are the stack shutting sockets, and were already there.
- Playwright checks: no horizontal scroll and no page errors in any shot.
  - Splash with the JS blocked: before 600 ms it shows the logo only (text opacity 0); after, the text is visible.
  - Boot with the RPC held: React is mounted (`__reactContainer` present), `#root` is empty and the splash is still shown.
  - Handoff: after getSelf returns 401 the splash has `display: none` and the welcome screen shows the logo.
- Screenshots are in `plans/dattqh/reports/fullstack-developer-261015-1555-logo-loading-shots/`:
  - `splash-early-*`, `splash-*`, `boot-*` and `panel-console-*`, each at desktop 1333x780 and mobile 390x844, in light and dark;
  - `splash-desktop-dark-reduced.png`;
  - `welcome-desktop-light.png`;
  - `mock-1333-light-loading.png` and `mock-390-dark-loading.png`;
  - `logo-sizes.png`.

## CSP

The nginx CSP (`style-src 'self'`, `script-src 'self'`) is unchanged. The splash needs no inline `<style>`, no `style=""` and no inline script: a test enforces this on index.html. The SVG uses presentation attributes only, and the CSS sits in the linked stylesheet.

## Concerns

- **Theme flash for some users.** Before JS runs, the splash follows the OS colour scheme. A user who forced the opposite theme in Settings sees the splash switch theme when `applyStoredAppearance()` runs. Avoiding that would need an inline script, which the CSP forbids.
- **Dev-only first paint.** The splash text is Vietnamese until React swaps it to the UI language. In `vite dev`, CSS loads from JS, so the very first dev paint shows the 88 px logo unstyled. Production is unaffected.
- **Re-run `pnpm brand:gen` after a logo edit.** It now needs Playwright's Chromium (already installed for e2e and perf). A test catches stale PNGs.
