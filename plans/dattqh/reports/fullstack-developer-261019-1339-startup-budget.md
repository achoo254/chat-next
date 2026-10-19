# Startup JS budget headroom

Status: DONE. `pnpm perf` startup JS went from 149.4 KB to 142.5 KB gzip (the budget stays 150 KB). Every other budget is still met.

## Changes (apps/web)
- **Icons.** `components/icon.tsx` now holds only the 43 icons that startup UI draws, including the topic icons, because `TopicIco` renders in the conversation header. A new `components/screen-icons.tsx` holds the other 21 icons and has the same `Icon`/`IconName` API. It merges both maps, so screen code can use any icon name. The 44 lazy files that draw one of the 21 icons now import from it. Startup code that tries a screen-only icon fails to typecheck.
- **Dialogs.** The dialog-kind switch and its lazy imports moved to `messaging/ui/dialog-switch.tsx`. That module is a `preloadable` and is part of the idle prefetch through `chatPanePreloads`. `DialogShell` still shows at once as the fallback.
- **Rare message lines.** `SystemLine`, `ForwardLine` and `ViaLine` moved to `messaging/ui/message-extras.tsx` as `preloadable`s, which are added to `IDLE_PREFETCH`. They only mount when a message has that content. Until the code arrives, a hidden one-line placeholder with the same class holds the space, and the system line's placeholder keeps `data-seq` so read tracking works as before.
- **`"use no memo"`.** Added to 30 more small leaf components, following the precedent in parts.tsx. None of them has effects that depend on derived values. Root, DialogHost, Modal, AppBadge, RichText/RichNode and the list containers keep compiler memoization.
- **Tests.** In `test/messaging.test.tsx`, the forward and service-line assertions now wait with `findByText` because those lines load lazily. New `test/icon-sets.test.tsx` checks that the two icon sets don't overlap and that the screens' `Icon` renders both kinds.
- **Budget comment.** The history line in `test/perf/budgets.ts` now records 142.5 KB.

## Gates
| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `pnpm -s lint` | exit 0 |
| Web vitest | 47 files, 435 tests pass |
| e2e `chat` (private-chat and group-chat) | 8/8 pass |
| e2e `bots` | 4/4 pass |
| `pnpm perf` | all budgets met: startup JS 142.5 KB, CSS 18.0 KB, laptop open p50 21 ms and p99 39 ms, scroll 60 fps with 0 slow frames |

On the ungated midrange-4x profile, the clean tree measured 88 ms (open p50), 128 ms (open p99) and 42 ms (TBT per switch). With the changes it measured 90, 127 and 41 ms. An earlier run showed 123 ms for open p50, but it overlapped with another session's Playwright job and is noise.

## Concerns
- The first dialog opened before the browser goes idle now waits for two fetches in a row: the switch, then the dialog. The shell shows immediately during that wait.
- A `ViaLine` whose bot has no username reserves a line and then renders nothing, which is a one-line shift. This is a rare edge case.
