# Multi-user QA of basic operability (local e2e stack)

Date: 2026-10-15. Tester: QA pass with Playwright, 2 to 3 simulated users in separate browser contexts (An, Bình, Chi, Dũng), desktop 1333x780 and mobile 390x844. Screenshots: `plans/dattqh/reports/tester-261015-1755-multi-user-qa-shots/`.

## Outcome

Basic operability works on the local stack for the main flows: private chat, groups with invite links, media, search, contacts, block, privacy effects, Cloud của tôi, the webhook, and the Bot API with inline buttons. Mobile layout shows no horizontal overflow. I found no blocker and no confirmed high-severity defect. The main gaps are spec items that are missing (typing indicator, offline state, creating topics), plus a few product decisions that need the owner's call. Two candidate "High" findings from my first runs were my own test errors and were retracted.

## Test environment

- Stack: `pnpm e2e --serve` (embedded Postgres, fake IdP, api on 4600, Vite on 5173). One stack only, started and stopped by me. Memory was 63% free at start. Ports 4600, 4610, 4630 and 5173 are free again.
- Accounts: An, Bình, Chi from the fake IdP. Dũng was used as a first-login account in the first run; later runs reused him.
- Drivers: throwaway Playwright scripts under the scratchpad `qa/` directory (not in the repo). Each step was isolated, and every page collected console errors, page errors, and failed responses.
- Not run: the repo's `pnpm e2e` suite itself. It needs the same ports as my stack, so I ran the flows by hand instead.
- No performance timings were collected. Speed was only observed, not measured.

## Findings

Severity: Blocker = core flow broken with no workaround; High = core flow broken or data risk; Medium = spec gap or wrong behavior with a workaround; Low = cosmetic or minor.

| ID | Sev | Finding | Steps | Expected vs actual | Screenshot | Suspected file |
|---|---|---|---|---|---|---|
| M-1 | Medium | Typing indicator ("đang gõ…") is not shown anywhere. | An opens the chat with Bình on desktop. Bình types in the composer without sending. Wait 1.5 s. | Expected: An sees "đang gõ…" in the header and chat list, as in the mock (`mockups/chat.html:613`, `:711`). Actual: no such text. The server gateway handles typing frames (`server/internal/gateway/handler.go`, `proto/app/v1/realtime.proto:30`), but the web app neither sends nor renders them. | `direct-05-typing-on-an.png` | `apps/web/src/messaging/ui/composer.tsx` (no send), `apps/web/src/messaging/data/remote-client.ts` (no receive) |
| M-2 | Medium | An appears as "@user" to everyone, although the sign-in label says "@an". | Bình opens the info panel for An, or searches "@an" in Chat mới. | Expected: "@an". Actual: "@user", also in the bot update payload (`"username":"user"`). Cause: `profile.UsernameBase` falls back to "user" when the login name has fewer than 3 characters, and "an" has 2. The search for "@an" still returns An, with the label "Khớp username", so the display and the matching disagree. Any user with a login name under 3 characters is affected. | `media-06-bin-receives.png`, `contacts-00-search-atan.png` | `server/internal/profile/profile.go:58-80` |
| M-3 | Medium | A refused private chat shows a generic retry message. | Chi sets "Nhắn tin cho tôi" to "Danh bạ". Dũng (not a contact, no earlier chat) searches "chi" and clicks Nhắn tin. | Expected: the reason, such as "Chi không nhận tin từ người ngoài danh bạ". Actual: "Không thực hiện được, thử lại sau ít phút.", and no composer opens. The server reason is "this user does not accept messages from you" (`server/internal/chat/users.go:161`), which the UI does not show. | `privacy-msg-02-dung-start.png` | `apps/web/src/messaging/copy/vi.ts:18` (generic `failed`), error mapping in the web client |
| M-4 | Medium | No offline state is shown. Needs a real network check. | An opens a chat with Bình. `context.setOffline(true)`, then wait 8 s. | Expected (copy exists: `vi.ts:89-91`, `conversation.tsx:97,117`, `composer.tsx:364`): header "Chờ mạng" or "Ngoại tuyến", placeholder "Tin sẽ gửi khi có mạng", a banner. Actual: header "Truy cập gần đây", placeholder unchanged, no banner, while `navigator.onLine` is false. Harness caveat: I could not close the realtime socket, which runs in a worker, so the app may never have seen a drop. What did work: a message sent offline showed the "Đang gửi" clock and reached Bình exactly once after reconnect. | `offline-02-queued.png`, `offline-07-after-8s.png`, `offline-03-after-reconnect.png` | `apps/web/src/messaging/ui/conversation.tsx`, `composer.tsx` (state source) |
| M-5 | Medium | Reloading while offline shows an empty page. | An goes offline, then reloads the tab. | Expected per mock (`mockups/chat.html:1250-1266`): old messages stay readable from cache in every state. Actual: `ERR_INTERNET_DISCONNECTED` and an empty body. No service worker exists in `apps/web/src`. | `offline-05-reload-offline.png` | Product decision: app-shell caching (PWA) in scope or not |
| M-6 | Medium | Topics (forum groups) cannot be created from the UI, so the topics flow cannot be tested end to end. | Tạo chat mới > Tạo nhóm. The full dialog has name, members, and a history toggle, but no topic option. | Expected: some way to create a topics group, since the UI already has topic views (`messaging/data/pending-backend.ts`, `ui/info-panel.tsx` TopicInfo). Actual: the dialog calls `remote.createGroup(title, ids)` with no forum flag. The server's `CreateGroup` accepts `forum bool` (`server/internal/chat/chats.go:255`). | `topics-03-create-full.png` | `apps/web/src/messaging/ui/create-dialogs.tsx:321`. Scope question for the owner. |
| M-7 | Medium | The webhook URL shown in the UI returns 404 when POSTed through the dev server. Dev stack only; production is not verified. | Create a webhook in the group panel. POST to the displayed `http://localhost:5173/hook/...`. | Expected: 200. Actual: 404 from Vite. The same path sent to the API port with `Host: localhost:5173` returns 200 `{"chat_id":10,"seq":15}`. The Vite proxy has `/rpc`, `/auth`, `/healthz`, `/bot/` and `/ws`, but not `/hook/`. | `webhook-02-created.png`, `webhook-03-after-submit.png` | `apps/web/vite.config.ts` (proxy block) |
| M-8 | Medium | Removing a member defaults to a ban. | Group info > Xem tất cả > Thao tác với Bình > Xoá khỏi nhóm. | The dialog's default option is "Xoá và cấm vào lại · mặc định" (permanent until unbanned). "Chỉ xoá" is the second option. This may be intended, but it is the riskier default. Needs the owner's decision. | `group3-01-remove-dialog-default.png` | `apps/web/src/messaging/copy/vi-screens.ts:680-692` |
| L-1 | Low | The desktop shortcut hint "⌘K" shows on mobile. | Open the chat list at 390 px. | Expected: no desktop-only hint on touch layouts. | `probe-main-mobile.png`, `m-01-list.png` | The search field component in the messaging list UI |
| L-2 | Low | Every signed-out page load logs a 401 console error from `UsersService/GetSelf`. | Open the sign-in page. | The session probe is expected to fail, but it appears as a console error. | `probe-login-desktop.png` | Session bootstrap in the web app |
| L-3 | Low | The "Đã tạo nhóm …" toast sits over the composer hint line. | Create a group. | Toast and hint overlap briefly. | `group-05-info.png` | Toast position in the messaging shell |

Two candidate findings were retracted after I found my own test errors: "Bình cannot download a file" (a timing issue; the button appeared on the next run) and "global search misses 'bao cao qa'" (the file name does not contain "qa"; the file body is not indexed by design).

## Flows that worked

- Sign in through the fake IdP at both sizes. Document-level horizontal overflow was 0 on every screen I checked, and no inner clipping was detected.
- Find a person by unaccented name ("Binh" finds Bình). Start a 1-1 chat from the result.
- Realtime delivery to the other user, with an unread badge that clears on open. Chat list ordering by recency, with Cloud của tôi pinned first.
- Read receipt "Đã xem" on the sender side.
- Reply with quote, edit with "đã sửa" label, recall with "Tin nhắn đã thu hồi", delete-for-me (sender still sees the message; the deleter does not).
- Forward dialog opens with Cloud của tôi as a target, and its send button reads "Gửi tới 1 chat". Delivery into Cloud was not checked. Reactions with a count. Pin in a 1-1 chat shows a "Tin ghim 3/3" bar and a system line, with no confirm dialog.
- Group: create with the privacy refusal dialog (offers Gửi link mời and Nhắn riêng). Invite link join for Chi, Bình, and Dũng (Dũng on mobile). Members list and member menu. Promote to "phó nhóm" with label. Remove with ban dialog. Leave group (the group disappears from the leaver's list). Realtime group messages.
- Channel: create, post, and "Thêm người đăng ký" control visible.
- Media: single image, file, and a three-image album sent and shown as a grid. Recipient download of the txt file. Info panel counts (Ảnh và video 4, File 1, Link 3).
- Search: global accent-insensitive search ("nhan roi" finds "nhận rồi"; "bao cao qa tuan" finds "Báo cáo QA tuần 42"). In-chat search for "tuan 42" finds one hit.
- Contacts: add contact from Danh bạ (count shows 1). Block: the blocked user's message shows the failed icon.
- Privacy effects: "Tìm tôi bằng username" set to "Không ai" makes An disappear from Chi's search ("Không tìm thấy ai"). Restoring it brings An back. Settings rows match the mock.
- Cloud của tôi: save note, message menu, "Xoá toàn bộ" clears the notes and keeps the Cloud chat. "Lưu vào Cloud của tôi" from a group message shows its toast.
- Webhook (Native JSON): create, POST with curl (200 with seq). Errors: wrong secret 404 `hook_not_found`, bad JSON 400 `invalid_json`, empty text 400 `text_empty`. The message appears in the group with the "Tích hợp: QA CI" label.
- Bot: name validation requires a "bot" suffix, with a clear message. Token issued after the fake-IdP reauth. Deep link asks first, then sends "/start hello". With curl: `getMe` 200, updates long-poll delivers /start, missing or bad token 401, `sendMessage` with inline keyboard 200, unknown chat 404, empty text 400. Inline button press reaches the bot as a callback, `answerCallbackQuery` succeeds, and the toast appears. Reply keyboard tap reaches the bot as text. URL button opens a "Mở link ngoài?" confirmation with Huỷ, Sao chép link, and Mở link.
- Offline send: the message queues with a clock icon and is delivered exactly once after reconnect (see M-4 for what is missing).
- Mobile 390 px: chat list, chat, send and receive, message menu, info panel, search, privacy page, and the create-group dialog all render without clipping.

## Not verified

- Voice messages: not attempted, since fake microphone media was not set up.
- Typing from the web client: covered by M-1.
- Link preview: `https://example.com` showed as plain text with no preview and no network error. The sandbox may have no outbound internet, so this is inconclusive.
- Notification permission prompt: the browser context denies notifications, and the app showed no in-app prompt on a first login. The real first-visit behavior needs a browser profile with the default permission state.
- Mention popup on "@": no suggestion list appeared for "@bi" in the group composer. Inconclusive.
- Channel subscription by the owner: no refusal dialog appeared when adding Chi. Chi already had the channel in the list, so I cannot tell whether the add changed anything.
- Ban list and unban, delete for everyone, group topics: not reached.

## Recommendations (priority order)

1. Owner decisions first: M-6 (is topics in scope for v1), M-8 (ban by default), M-2 (username rule for short login names), M-5 (offline shell caching).
2. Implement M-1 (typing) and M-4 (offline state). Both are in the mock and in the copy. Re-test M-4 on a real device.
3. Replace the generic message in M-3 with the reason the server already sends.
4. Add `/hook/` to the Vite proxy for dev, so the webhook URL works from the dev origin (M-7).
5. Fix L-1 to L-3 when touching those components.
6. Add e2e cases for the flows that have no coverage yet: webhook, Cloud clear, privacy effects, and the bot inline/reply keyboard round trip.

## Status

Status: DONE_WITH_CONCERNS

Summary: Basic operability works across 1-1 chat, groups, invite links, media, search, contacts, block, privacy, Cloud, webhook, and the Bot API at both viewports. No blocker or high defect was confirmed. Typing, offline indicators, and topics creation are missing against the spec, and several product decisions need the owner.

Concerns:
- M-4 (offline indicator) is inconclusive because the harness could not drop the realtime socket. Needs a manual airplane-mode check.
- The repo's own `pnpm e2e` suite was not run, because it needs the same ports as the stack I used.
- Topics could not be tested end to end (M-6).

## Unresolved questions

- Is the typing indicator in scope for this release? The mock shows it, but the server and the web app disagree.
- Should a login name shorter than 3 characters fall back to "user" (M-2), or should the username be derived differently?
- Is creating a topics group part of v1 (M-6)?
- Is "remove and ban" the intended default when removing a member (M-8)?
- Is app-shell caching for reloads offline in scope (M-5)?
- Does the offline indicator appear on a real network drop (M-4)?
- Should the owner see the private-chat denial reason (M-3), or keep the generic message on purpose?
