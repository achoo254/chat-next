# Code review: R5 slice A web (commit 4affc40, apps/ + packages/)

Date: 2026-10-15. Read-only review. Scope: `git show 4affc40 -- apps/ packages/` plus `server/internal/auth` for the reauth return path.

## Verification run

- `apps/web`: `vitest run test/bots.test.tsx test/cloud.test.tsx --maxWorkers=2`: 2 files, 21 tests passed.
- `packages/core`: `vitest run test/bot-markup.test.ts test/saved-chat-clear.test.ts`: 2 files, 5 tests passed.
- I did not re-run full lint, typecheck, e2e or perf. The developer report records them as green.

## Critical

None.

## High

### H1. `?after=token` reissues the token without a fresh user action. It can fire twice, and a link from someone else can trigger it.
`apps/web/src/messaging/bots/console.tsx:401-418, 722-728`

`BotPage` reads `after` once with `useState(takeAfter)`. React keys the page by `botId` only, so the value lasts for the life of the page across tab changes. `TokenTab` guards with `started = useRef(false)`, but that ref lives in `TokenTab`, which unmounts whenever another tab is shown.

- **Failure scenario 1 (self-inflicted):** the user comes back from reauth to `/console/7/token?after=token`, and token A is issued and shown. They copy it, click "Hồ sơ", then click "Token" again. `TokenTab` remounts with `issueNow=true` and `started.current=false`, so `issue()` runs again. The sign-in is still within the 10-minute window, so the call succeeds: token B is issued and token A, which they just saved, is revoked. Their bot breaks silently.
- **Failure scenario 2 (cross-user):** anyone can post `https://chat.<d>/console/<botId>/token?after=token` in a chat. Bot ids are visible as user ids. `linkOpener` treats the tenant host as trusted and opens it in a new tab without asking (`rich-text.tsx` linkOpener, the `isTrustedHost` branch). If the bot owner clicks it within 10 minutes of any sign-in (the session `AuthTime` is set on every login, not only on reauth), the bot's token is rotated with no confirmation. This is an integrity and DoS problem against production bots. The token is not leaked: only the owner sees it.
- `after=delete` has the same remount problem, but it only reopens the confirm dialog, so it is not destructive.

**Fix (simplest):** on return, open the existing confirm dialog (`setDialog("confirm")`) instead of auto-issuing. That matches what `after=delete` does, and the user clicks once more. Also make `after` one-shot at the `BotPage` level, for example with an `onConsumed` callback that sets it to `null`. If auto-issue must stay, store a nonce in `sessionStorage` before the redirect (`botId:after:nonce`), carry the nonce in `return_to`, and on return issue only when it matches, then delete it.

Tests miss this. `bots.test.tsx:130` covers only a single mount.

## Medium

### M1. The "Cloud của tôi" clear note says "vẫn ở đầu danh sách", which is false when Cloud is not pinned
`apps/web/src/messaging/copy/vi-screens.ts` (`savedNote`), `packages/core/src/sync/apply.ts:180-184`

`ensureDialog` re-inserts the dialog with `top_date = 0`. The list is ordered `pin_rank DESC, top_date DESC` (`repository.ts:150`), so an unpinned Cloud drops to the very bottom, possibly below the first page. The user is told it stays on top and then cannot find it. Either reword the note ("Cloud của tôi vẫn còn trong danh sách"), or keep the cleared dialog's previous `top_date` (or give it the clear time) so it does not sink.

### M2. The reply keyboard is chosen only from the loaded message window
`apps/web/src/messaging/bots/bot-chat.tsx:115-124, 221`

`activeKeyboard` scans `window_.keys`. Two cases go wrong:
- **(a)** The window is anchored on an older message (search hit, reply jump). The keyboard from an older bot message shows, possibly one the bot has since removed.
- **(b)** Many messages come after the bot's keyboard message, so it falls outside the tail window. The keyboard disappears even though it was never removed.

Telegram keeps the newest keyboard state for the whole chat. A simple local fix: query SQLite for the newest bot message with `reply_keyboard IS NOT NULL` in the chat, or cache that seq per chat in core, instead of deriving it from the visible window.

### M3. Inline button press has no client-side timeout
`apps/web/src/messaging/ui/message-item.tsx:703-722`

The spinner clears only when `bots.press` settles. The server's 10-second `timed_out` covers a slow bot but not a stalled connection: proxy buffering, a half-open TCP connection after network loss, or a laptop waking from sleep. In those cases the button stays "Đang chờ bot" indefinitely, and `pressing.has(key)` blocks pressing it again. Add an `AbortSignal.timeout(~15s)` or a Connect `timeoutMs` to `pressInlineButton`, and map the timeout to `notResponding`.

## Low

- **L1. `StartBot` retries after a failure send a second `/start`.** `client.ts:311` generates a new `randomId` on every call. In `bot-link-dialog.tsx:94-103` and `bot-chat.tsx:74-83`, if the first request succeeded on the server but the response was lost, pressing again sends `/start` twice. Keep one `randomId` per dialog/bar instance (`useState(cryptoRandomId)`) and pass it in.
- **L2. A bot answer URL to a trusted host is likely blocked as a popup.** `message-item.tsx:718` calls `ctx.openLink(answer.url)` after an `await`, so the user gesture has expired. `window.open` for trusted hosts is likely popup-blocked. Untrusted hosts are fine because they go through the confirm dialog, which is a new gesture. Either route trusted-host URLs through the same confirm too, or use `location.assign` for same-origin links.
- **L3. The thumbnail data-URL builder duplicates an existing helper.** `PreviewThumb` (`chat-row.tsx:216-224`) rebuilds `inlineThumbUrl` from `media/use-media.ts:146`. This was probably done to keep the media chunk out of startup. Move the 1-line helper to `data/format.ts` (or core) and import it from both places.
- **L4. Enter in the command menu sends the highlighted command, not the typed text.** `bot-chat.tsx:205-211`. If you type `/deploy` exactly and the bot lists `deploy_prod` first, Enter sends `/deploy_prod`. Telegram Desktop behaves the same way, so this is acceptable. Ranking an exact match first would avoid surprises.
- **L5. `startParam` is read from `window.location.search` during render.** `chat-screen.tsx:276`. When `/b/x?start=a` is replaced by `/b/x?start=b` in place, the route object is identical. If the router does not re-render on a query-only change, the dialog keeps showing the old command. That is harmless, because the command it shows is the one it sends, but it is stale.
- **L6. The new copy line carries a misleading comment.** `ReplyKeyboard.hidden` is serialized into the `reply_keyboard` JSON as `hidden:false` (`writes.ts:752`). This is harmless because `parseKeyboard` reads the column, but the stored JSON then contradicts the "never from the server" comment. Strip `hidden` before `JSON.stringify`.

## Checked OK

- **Deep link.** The dialog sends nothing until "Gửi /start". Cancel, Esc and close all go home with a toast. The start param is validated on both sides: `[A-Za-z0-9_-]{0,64}` on the client (`api.ts:178`) and on the server (`chat/bots.go:121`), so nothing can be injected into the command text. The username regex is enforced in the router. A non-bot username gives "not found". In-app `/b/` links from messages still go through the dialog.
- **Reauth `return_to`.**
  - Client: `isReturnPath` rejects `//`, backslash, whitespace, control characters and `/auth*`.
  - Server: `CleanReturnTo` (`auth/pages.go:77`) adds `url.Parse` with no scheme or host, a 512-byte cap and a `/auth` exclusion. The value is rendered with html/template into the meta refresh, and the page has a strict CSP.
  - I found no open redirect. `returnPathFor` keeps the query only for the bot route.
- **Token handling.**
  - The token lives only in `TokenTab` component state.
  - It is cleared by "Tôi đã lưu token" and on unmount.
  - It does not appear in `useMyBots`, SQLite, localStorage, toasts, `BotError` messages or logs.
  - `takeAfter` strips the query with `replaceState`, so a reload does not reissue. H1 is the remount case, not the reload case.
- **XSS.** Bot text, button labels, command descriptions, alert text and the placeholder all render as React text or attributes. There is no `dangerouslySetInnerHTML`. URL buttons keep `isAllowedLink` plus the external-link confirm, and callback buttons never navigate.
- **Migrations 9/10.** Both are plain `ALTER TABLE ADD COLUMN`: one nullable, one `NOT NULL DEFAULT 0`, which SQLite accepts. Each runs in a batch with `user_version`. All message reads use `SELECT *` and `optionalStr`/`bool`, so they are safe on old rows. The upsert does not touch `keyboard_hidden`, and recall nulls `reply_keyboard`. Cached pre-upgrade messages carry no bot markup because bots did not exist before this release.
- **`keyboard_hidden`.** It survives bot edits and restarts (unit test), and the message signature includes it, so `useItem` refreshes. One-time keyboards hide on tap. `remove` returns null from `activeKeyboard`.
- **`ensureDialog` condition.** The server sets `member_count = 2` for private chats and `1` only for the self chat (`chat/chats.go:180, 242`), so `memberCount === 1 || peerUserId === selfId` cannot re-add a deleted ordinary private chat. In the same batch, `purgeChat` runs and then `ensureDialog` runs. `forgetChat` touches only in-memory pts, not the dialog.
- **Pending state.** A double press on the same button is guarded. Other buttons stay usable. `finally` clears the state after unmount because it is a module-level `Cell`.
- **Thumbnails.** Recalled messages, action messages and messages without a thumb get no image. Only photos and videos show one, and the text falls back to "Ảnh"/"Video". The server re-encodes `inline_thumb` to JPEG, and the CSP allows `img-src data:`.
- **Performance.** The Console, `bot-chat`, the link dialog and `client.ts` (Connect + bot_admin schemas) are all lazy. The composer loads `BotLayer` only when `botId != 0`.
- **React Compiler.** The keyboard message is read through `useItem`, not memoized `store.item` alone. `actionsRef` is assigned in an effect without deps, which is intended.
- **UX rules.** The reply keyboard uses `flex: 1 1 0; min-width: 0; overflow-wrap: anywhere`, so a 12-column row wraps rather than scrolling horizontally. The command menu scrolls only vertically. I saw no webhook or roadmap placeholders. The Vietnamese wording is consistent: "Bắt đầu", "Đang chờ bot", "Bot không phản hồi".

## Recommended actions

1. **H1:** confirm on return instead of auto-issuing, or make the action one-shot and nonce-bound. Add a test: return with `after=token`, switch tabs, then expect no second `resetToken`.
2. **M1:** fix the note wording or the `top_date` handling.
3. **M3:** add a client timeout to `PressInlineButton`.
4. **M2:** derive the active keyboard from local storage rather than the window. This can be done in the next slice.
5. **L1-L6:** handle opportunistically.

## Unresolved questions

- After a clear, should an unpinned Cloud keep its list position (product decision), or is the sink acceptable once the note is fixed?

Status: DONE_WITH_CONCERNS
Summary: The return path, deep-link param, XSS, migrations and `ensureDialog` all hold up. One High: the auto-issue on `after=token` can rotate a bot token without a fresh action, both on a tab switch and through a crafted link opened within 10 minutes of sign-in.
Concerns: H1 should be fixed before real bot owners rely on tokens. M1 is a user-visible wording mismatch.
