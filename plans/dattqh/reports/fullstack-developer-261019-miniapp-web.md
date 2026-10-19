# R6 Mini Apps: web and core (2026-10-19)

Status: done with one deploy concern (CSP). Contract: `phase-16-mini-app.md`, "Hợp đồng R6 web". Nothing is committed.

## What changed

- **Core** (`packages/core`): `MessageAction` kind `mini_app_data {buttonText}` from `MessageAction.miniAppData`, kept in the local database; `MessageButton.miniAppUrl` for inline Mini App buttons (mapped and persisted). The platform-web API surface is unchanged.
- **History line**: "Đã gửi dữ liệu từ “<nút>” tới bot" / "Đã gửi dữ liệu tới bot" (en: "Data from “<button>” sent to the bot" / "Data sent to the bot").
- **Bots client**: `openMiniApp`, `allowMiniAppWrite`, `sendMiniAppData`; `miniAppUrl` on `OwnBot`, `BotInfo` and `BotChanges`.
- **Console**: a new "Mini App" tab (`/console/<id>/mini-app`, `mini-app-settings.tsx`). It has the URL field with client checks (https and a domain, no credentials, no IP, no `#` fragment, 512 characters at most) and shows the server's refusal. It previews the header with the real host and saves through UpdateBot (an empty value removes the Mini App). The side card covers initData verification (Ed25519, `getMiniAppKey`, the SDK list) and gives the `…/miniapp/sdk.js` URL.
- **Opening**:
  - An inline Mini App button shows the apps glyph. Pressing it calls OpenMiniApp(bot, chat, seq, url) and then shows the container.
  - In the private chat with a bot that has a Mini App, the composer shows "Mở app", which opens it with url `""` and seq 0.
  - If opening fails, a toast reads "Không mở được Mini App".
- **Container** (`mini-app.tsx`, a lazy chunk of 3.95 KB gzip):
  - It is a fixed panel 400 px wide on the right, and full screen at 760 px or less.
  - The app draws the header: the bot's name, a lock icon with the URL's real host, and close. The mockup's "content provided by" strip is included.
  - The iframe has the contract's sandbox, and its src is the URL plus `#chatAppData=…&chatAppTheme=…`.
  - The app draws the main button. The write-access and open-link popups cover the header and the content, which are made `inert` meanwhile.
- **Bridge** (`mini-app-bridge.ts`):
  - A message is accepted only when `event.source` is the iframe and `event.origin` is the URL's origin. It must be at most 4 KB as JSON and pass the schema check. Unknown types are dropped.
  - Messages to the iframe always target the Mini App's origin.
  - The app posts `theme` when the app theme changes.
  - `open_link` goes through `isAllowedLink` (ADR 0004), then a confirm popup, then `window.open(url, "_blank", "noopener,noreferrer")`.
  - `data_send` is honoured only for a Mini App opened from the bot's private chat (or chat 0). The server cannot enforce this (see its report).
- **sdk.js**: `apps/web/public/miniapp/sdk.js`, which Vite copies to `dist/miniapp/sdk.js`. nginx serves it through `location /` (`try_files $uri`). It exposes `window.ChatApp`, sends with postMessage to `"*"`, and only listens to messages whose `event.source === window.parent`.

## Gates

| Check | Result |
|---|---|
| apps/web `tsc --noEmit -p .` | 0 errors |
| packages/core `tsc --noEmit -p .` | 0 errors |
| repo `eslint . --max-warnings=0` | 0 problems |
| apps/web vitest (maxWorkers=2) | 46 files, 426 tests passed; the new `test/mini-app.test.tsx` has 14 |
| packages/core vitest (maxWorkers=2) | 26 files, 786 tests passed |
| apps/web `pnpm run build` | ok |
| apps/web `pnpm run perf` | all budgets met; startup JS 148.9 KB (budget 150), CSS 18.0 KB (budget 20) |

## Concerns

1. **The production CSP blocks the iframe.** `infra/chat/nginx/chat.hoandat.com.conf` (and the tenant configs that `render-tenants-nginx.sh` derives from it) sends `default-src 'self'` with no `frame-src`. Browsers will therefore refuse to load any Mini App URL. Adding `frame-src https:` to every CSP header in that file is required before release, and `docs/infrastructure-inventory.md` must be updated in the same commit. `infra/` is outside my ownership, so I left it unchanged.
2. **Where the code departs from the mockup, following the contract:**
   - The mockup header's back button and "more" (dots) button are left out, because the contract's header is the name, the host and close, and the bridge has no `back_button` event.
   - The Console preview drops the back icon to match the container.
   - The mockup's SDK cards are placeholder links, and there is no docs URL to point them to. They are shown as a plain list, with one added line giving the sdk.js URL.
3. **Small departures from the task wording:**
   - The history line puts the button text in curly quotes (“…”), matching the app's other system lines.
   - "Mở app" appears in the private chat's composer only. The bot profile has no entry point yet (`chat_type` `sender`).
4. **Browser review.** I did not review the screens in Chrome in this session. The no-horizontal-scroll rules are applied in CSS but were not checked visually at Windows 150%.
5. **Phase checklist.** The phase-16 Todo checkboxes are unchanged; the plan status belongs to the orchestrator.
