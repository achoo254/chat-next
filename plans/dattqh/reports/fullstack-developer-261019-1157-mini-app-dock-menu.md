# Mini App: docked, "⋯" menu, minimize (2026-10-19)

Status: done, not committed (the controller commits).

## What changed

- **Mock first.** `mockups/bots.html` #mini-app is now interactive: docked in the info column's place, the "⋯" menu, minimize to the chip, restore and close. It also has a new shot, #mini-app-minimized (menu and chip), and #mini-app-permission headers without the back button. `mockups/mobile.html` #mini-app has three phones: full screen, menu, and the pill above the composer. `assets/mock.js` gains `i-minimize`. The provider strip is gone everywhere.
- **Docking.** `ui.miniApp` is now `Cell<OpenMiniApp | null>` (`{request, minimized}`). ChatScreen drops `no-info` while a Mini App shows and does not render InfoPanel. `infoOpen` is never touched, so minimizing or closing brings the column back as it was. The info "i" button while a Mini App is docked minimizes the Mini App and opens the info column (one slot). `.mini-app` is a grid item in the last column. At 761–1100px it is an overlay, like the info column there. At 760px and below it is full screen.
- **Header.** Bot name, host with a lock, "⋯" (`PopupMenu`, `aria-haspopup="menu"`), and close. The menu has four items:
  - Tải lại calls `launchMiniApp` again with the original button URL (`MiniAppRequest.buttonUrl`), so the frame gets new init data and remounts.
  - Thu nhỏ minimizes.
  - Hồ sơ bot opens the existing `profile` dialog.
  - Báo cáo bot opens the existing `report` dialog for the user target. It shows only when `backend.features.has("report")`.
- **Minimize.** The section gets `hidden`; the iframe stays mounted. A new `ui/mini-app-slot.tsx` places the chip:
  - wide screens: at the top of the conversation, in flow;
  - narrow screens: a pill in a zero-height dock between the messages and the composer;
  - no conversation shown: a fixed pill.
  The chip comes from the lazy Mini App chunk. Focus moves to it on minimize and back to the header on restore.
- **Bridge.** The container posts `deactivated` and `activated`. `sdk.js` emits them through `onEvent` and keeps `ChatApp.isActive`. The demo page logs "Mini App bị thu nhỏ" and "Mini App mở lại". phase-16 (Container and Bridge bullets) and docs/bot-api §11 are updated.

## Verification

- `apps/web: npx tsc --noEmit` exit 0; `pnpm -s lint` exit 0.
- web vitest: 46 files, 433 tests passed. That includes 7 new tests (menu, profile and report, reload, failed reload, minimize with the same frame and deactivated/activated, the chip across chats and its x, docking in the info column's place, replace on open). Each new test also passes when run alone.
- core vitest: 26 files, 786 tests passed.
- `pnpm -s e2e bots`: 4/4 passed. The Mini App scenario now checks the menu, minimize, restore, the SDK events and frame state at 1280×720, 1366×768 and 390×844. It also checks there is no sideways scroll, that the panel does not overlap the conversation, and that the pill sits above the composer.
- `pnpm -s perf`: all budgets met; startup JS 149.4 KB of 150 KB (was 148.9 KB in the last report).

## Notes

- Between 761 and 1100px the Mini App overlays the conversation, as the info column does there. Four columns would leave the chat about 100–300px wide.
- Startup JS has about 0.6 KB of headroom left.
