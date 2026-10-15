# PWA + Web Push: implementation report

Date: 2026-10-16. Status: done locally. Nothing is committed, pushed or deployed.

## Outcome

- The web app now installs as an app. There is a new tab in Cài đặt › **Cài ứng dụng**:
  - Chrome, Edge and Android browsers get a button that opens the browser's own install dialog (`beforeinstallprompt`).
  - Safari on iPhone and iPad gets the three "Thêm vào Màn hình chính" steps.
  - Inside the installed app it shows "đã cài". Other browsers get a pointer to the browser menu.
- Chrome reports **0 installability errors** on a production build (checked with `Page.getInstallabilityErrors`). The manifest now also has `id`, `lang`, `dir`, `categories` and `prefer_related_applications`. `<head>` gains `theme-color` and `apple-mobile-web-app-title`, both taken from the brand config.
- Web Push is done end to end:
  - The server sends RFC 8291 encrypted, VAPID-signed pushes from a new outbox consumer called `push`.
  - The service worker shows one notification per chat. Clicking it focuses a tab and opens the chat, or opens a new window.
  - Cài đặt › Thông báo has a new card, **Thiết bị này › "Thông báo khi đã đóng app"**. Its states follow the mock: needs install on iPhone, blocked by the browser, not supported, and hidden entirely when the server has no key.
- Mock updated first: `mockups/settings.html#notifications` (device card plus its state variants) and the new `#app` section. Checked at 1333x780 and 390x844 with no horizontal overflow.

## Push rules (server `internal/push`, `chat.PushTargets`)

- **Who gets a push:** current members of the chat other than the sender, on a live session (not revoked, not idle past 30 days, not older than 90 days).
- **Who is skipped:** anyone who muted the chat, turned that chat type off in notification settings, or blocked the sender.
- **Foreground rule (Phase 3):** a user with a foreground socket anywhere gets no push.
- **No double notification on the same device:**
  - The core now marks each in-tab notification request with `background` (no visible window of the app).
  - On a device where push is on, the web filter drops those background in-tab notifications, because the server pushes exactly then.
  - In-tab and pushed notifications share the tag `chat:<id>`, so one replaces the other.
  - Opening or reading a chat also closes the notifications the service worker showed for it.
- **"Hiện nội dung tin" setting:** when on, the push shows the chat or sender name and the text (cut to 140 runes, with media labels in vi or en). When off, it shows only the brand `pushSenderName` and "Bạn có tin nhắn mới".
- **Batching and delivery options:**
  - One push per subscription per chat per pass.
  - `Topic: chat<id>`, `TTL` 24 h, `Urgency` high for private chats and normal otherwise.
  - Payload padded to 128 bytes.
  - 16 workers with a bounded queue of 10k.
  - Messages older than 15 min are not pushed.
- **What is never pushed:** service, recalled and `silent` messages.
- **Failures:** 404 or 410 deletes the subscription. Five consecutive 4xx answers (other than 429) also delete it. 429, 5xx and network errors are only logged; logs name the push service host, not the endpoint.
- **SSRF:** endpoints must be https on port 443 on `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com` or `<one label>.notify.windows.com`. This is checked when registering and again before every send. The client follows no redirects and uses no proxy.
- **Crypto:** written with the Go standard library only (ecdh, hkdf, aes-gcm, ecdsa). It reproduces the RFC 8291 Appendix A vector byte for byte. No new Go dependency.

## Contract and migration

- New proto `proto/app/v1/push.proto` adds `PushService` with `GetWebPushConfig`, `RegisterWebPush` and `UnregisterWebPush`. The change is additive and `buf breaking` passes.
- New migration **`0018_web_push.sql`**, expand-only:
  - table `push_subscriptions`, unique on session and on endpoint;
  - trigger `user_sessions_revoked_push`, which deletes the subscription when its session is revoked;
  - cursor row `push`.
- `NotificationRequest.background` is a new optional field in `packages/platform`.

## For the controller: production

- **nginx changes: none.** Push is outbound from `chat-api`. `sw.js`, the manifest and the icons are already served.
- **Root deploy: yes, once.** `infra/chat/` changed: the new `generate-vapid-key.sh`, `setup-server.sh` now calls it, and `.env.production.example` was updated. Rsync or root-deploy them before pushing, per the deploy rules.
- **Migration:** 0018 runs automatically in `activate-release.sh`.
- **Env vars on prod** (`/opt/chat/.env`):
  - `WEB_PUSH_VAPID_PRIVATE_KEY`: **required to turn Web Push on.** Generate it on the server as root with `bash /opt/chat/infra/generate-vapid-key.sh /opt/chat/.env`. The script only adds the line when it is missing, never replaces an existing key, never prints the private key, and prints the public key for checking. The public key is derived from the private key, so there is no separate public-key variable.
  - `WEB_PUSH_SUBJECT`: optional. Use `mailto:` or `https:`; it defaults to `CHAT_PUBLIC_URL`.
  - `WEB_PUSH_ALLOW_LOCAL`: development only. Production refuses to start with it set.
- **Reload and check:**
  1. Run `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`.
  2. The startup log should show `"msg":"web push","enabled":true`.
  3. Run the manual check in `docs/deployment-guide.md#web-push-và-cài-ứng-dụng-pwa`.
- **Without the key:** the app hides the device card and behaves exactly as today.
- **Inventory:** `docs/infrastructure-inventory.md` lists the key as "chưa đặt" and records the outbound push-service hosts. Update the line once the key is set.

## Verification (all run in this session, sequentially)

| Gate | Result |
|---|---|
| gofmt / go vet | clean |
| golangci-lint `./...` | 0 issues |
| `go test -race -count=1 -p 2 ./...` | all packages ok, including the new `webpush`, `push`, `api` (push RPC tests), `config`, `brand` |
| `pnpm lint` | 0 warnings; check-brand ok |
| `pnpm typecheck` | 0 errors |
| vitest (`--maxWorkers=2`) | core 774, platform-web 18, brand 12, web 375 (38 files): all pass |
| `pnpm perf` | startup JS **148.3 / 150 KiB** (was about 147.5), CSS 17.2 / 20 KiB; all browser budgets pass |
| `pnpm e2e` | **26/26**, including the new `web-push.e2e.ts` |
| render-check (`settings` pages) | 12 renders (3 viewports x light/dark), 0 errors or overflow |
| proto lint / breaking / gen | ok; regenerating changes only the new files |
| gitleaks on the changed files | no leaks. A full-tree scan shows 2 findings in existing test files I did not touch (`apps/web/test/app.test.tsx`, `messaging-units.test.ts`) |
| Chrome installability (production build) | 0 errors |

What the new tests cover:
- **Server:** the RFC 8291 vector; round trip and padding; key validation; VAPID signature, claims and token cache; the endpoint allowlist table; sender headers, status classification and refusal to follow redirects; register, replace, move, revoke and disabled cases; filtering by mute, settings, preview, block, foreground, left member and staleness; group, channel and English text; 410 cleanup and deletion after 5 rejections; delivery kicked by a commit in under 900 ms.
- **Web:** the subscribe, renew, sync and leftover logic on fakes; the device card on and off, hidden and unsupported states; install prompt, iPhone and installed states; the service worker's push, notificationclick and pushsubscriptionchange handlers; the open-chat message.
- **E2E:** register over RPC; no push while the app is in the foreground; push after the tab closes, decrypted in Node with the VAPID JWT verified; preview off; unregister.

## Files

New:
- `proto/app/v1/push.proto` and the generated `push_pb.ts`, `push.pb.go`, `push.connect.go`
- `server/migrations/0018_web_push.sql`
- `server/internal/webpush/{encrypt,vapid,endpoint,send}.go` and its tests
- `server/internal/webpush/webpushtest/`
- `server/internal/push/{push,consumer,notification,deliver}.go`, `push_test.go`
- `server/internal/chat/push.go`
- `server/internal/rpc/push_service.go`
- `server/internal/api/push_test.go`
- `infra/chat/generate-vapid-key.sh`
- `apps/web/src/install-prompt.ts`
- `apps/web/src/messaging/push/{push-device,web-push,web-push-client}.ts`
- `apps/web/src/messaging/settings/{device-push,install-app}.tsx`
- `apps/web/src/sw/{push-handlers,push-messages}.ts`
- tests: `web-push.test.tsx`, `sw-push.test.ts`, `support/fake-push.ts`, `e2e/web-push.e2e.ts`

Modified: 41 files, listed by `git status`. They include config, api, rpc handler, brand (`pushSenderName` now goes to the server), e2e stack, core and platform, the platform-web clear path, settings, router, icon, copy, the mock, the phase-03 note and the docs (deployment guide, infrastructure inventory, server README).

## Decisions taken without asking (scoped, low risk)

- I implemented the crypto myself with the standard library instead of adding `webpush-go`. It is verified against the RFC 8291 vector and decrypted independently in Node in the e2e test.
- Phase 3 rule: a foreground session anywhere suppresses the push. A hidden but connected tab still gets the push, and its in-tab notification steps aside; this also covers mobile PWAs whose JavaScript is frozen in the background.
- With the preview off, the title is hidden too (brand name only), per the Phase 3 text. The in-tab notification still shows the chat title.
- Delivery is best effort and at most once: the cursor is saved before sends are queued.

## Concerns and follow-ups

- Startup JS headroom is now about 1.7 KiB.
- `push`, `bots` and the realtime sweeper are now three consumers with the same cursor and gap logic. By the rule of three it should be extracted, but I did not refactor `botupdates` here.
- Not done in this slice, left for R7/R8: native APNs and FCM, lanes and quota, the Redis badge counter, and clearing notifications on other devices through push.
- I could not test a real push from Chrome, Firefox or Safari through FCM, Mozilla or Apple, because headless Chromium cannot subscribe. The manual production check above covers it.

Status: DONE_WITH_CONCERNS
Summary: Installable PWA (0 Chrome installability errors) and end-to-end Web Push are in place, with every gate green (Go race suite, lint, typecheck, vitest, perf, e2e 26/26). Prod needs one root deploy plus `WEB_PUSH_VAPID_PRIVATE_KEY`, generated by the new script.
Concerns: about 1.7 KiB of startup budget left; real-browser push through FCM, Mozilla and Apple can only be checked on prod; outbox cursor logic is now duplicated in three places.
