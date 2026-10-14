---
phase: 1
title: "Phase 1: Chốt contract và nền móng monorepo"
status: completed
priority: P1
effort: "L"
dependencies: []
principles: [1, 6, 7, 3, 5]
---

# Phase 1: Chốt contract và nền móng monorepo

<!-- Updated: Red Team 2026-10-13 - bổ sung ADR epoch/sync_mode/outbox/topology/auth web/link scheme, proto theo domain, đặc tả fold đúng -->
<!-- Updated: Validation Session 2 2026-10-14 - app thuộc hệ sinh thái hoandat: ADR 0006 chuyển sang đăng nhập qua hoandat-auth, thêm ADR 0010 tenant theo domain, RPC auth mới, brand.config theo chat.<domain> -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - RPC config.GetAppConfig -->

## Goal

Khoá mọi contract mà sửa về sau phải migrate dữ liệu hoặc phá vỡ client: định danh, sync (kể cả failover và chat lớn), outbox, định dạng text, fold tiếng Việt, đăng nhập qua IdP `hoandat-auth` và phiên chat, tenant theo domain, topology client theo nền tảng, branding. Đồng thời dựng monorepo, môi trường dev và CI.

## Context Links

- [Báo cáo tổng hợp xia](../reports/xia-261013-1139-telegram-like-chat-design.md)
- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md)
- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 2.4 (plugin native không gọi được từ Worker), 5.1 monorepo
- [Nền tảng Bot](../reports/researcher-261013-1120-telegram-bot-platform.md) — chỉ phần kiến trúc; sản phẩm **không** tương thích Telegram
- [Hệ sinh thái hoandat](./plan.md#hệ-sinh-thái-hoandat) và `hoandat-auth/docs/integration-guide.md` (mục 2–5, 8, 11)

## Key Insights

- Các rủi ro critical của dự án đều là contract: ID, sync, outbox, định dạng text, topology client, lưu phiên. Chốt sai thì các phase sau phải làm lại.
- Mọi id lộ ra ngoài phải < 2^53 (an toàn JavaScript). Snowflake chỉ dùng nội bộ; tin nhắn lộ ra bằng `(chat_id, seq)` ở **mọi** bề mặt: client, Bot API, webhook, search.
- pts/seq chỉ đúng nếu không bao giờ chạy lùi. Failover Postgres bất đồng bộ có thể làm lùi, nên contract cần cả replica đồng bộ lẫn `server_epoch` để client phát hiện.
- Capacitor plugin và Tauri `invoke` không gọi được từ Web Worker. "Mọi thứ trong worker" chỉ đúng với web.
- SQLite FTS5 `remove_diacritics 2` không fold `đ`/`Đ` (đã kiểm chứng bằng sqlite3), nên fold là hàm ứng dụng có spec và test vector dùng chung TS/Go.
- Sản phẩm độc lập với Telegram; tên sản phẩm cấu hình được qua `brand.config.json`.
- App thuộc hệ sinh thái hoandat: danh tính gốc nằm ở IdP `hoandat-auth`, app chat không giữ mật khẩu, OTP hay 2FA. IdP chỉ đăng nhập bằng Google/GitHub và không gửi email. Phiên chat vẫn do app cấp (WS và RPC cần độ trễ thấp, không gọi IdP mỗi request), nhưng luôn gắn với một grant của IdP và chết theo grant đó.
- Tenant theo domain là contract dữ liệu: thêm `tenant_id` sau khi đã có dữ liệu thì phải migrate mọi bảng, nên phải có từ migration đầu.

## Requirements

Functional:
- Monorepo pnpm + một Go module; package npm đặt tên `@app/<tên thư mục>`.
- Protobuf là nguồn sự thật của protocol client ↔ server, mỗi domain một file, sinh code Go và TS.
- ADR (mỗi ADR: quyết định, lý do, hệ quả, cách thay đổi):
  - 0001 ID scheme (bảng dưới).
  - 0002 Sync: pts per-user, `chat_pts` cho chat `sync_mode=large`; `GetDifference`/`GetChatDifference`; `too_long`; `server_epoch`; thủ tục chuyển `sync_mode` một chiều khi chat vượt ngưỡng (update `chat_mode_changed` ghi vào log của từng thành viên kèm `chat_pts` gốc); update nhẹ `chat_activity` gộp theo chu kỳ để client biết chat lớn nào cần kéo; thứ tự kết nối lại: subscribe → đệm → `GetDifference` → hợp nhất theo pts; gap timer 150 ms.
  - 0003 Outbox: log có `id` tăng dần, partition theo thời gian, enum `kind` đầy đủ, mỗi consumer giữ cursor riêng, consumer cần thứ tự thì shard theo `chat_id` (hoặc `bot_id`), dispatch ngay sau commit + sweeper làm lưới an toàn.
  - 0004 Text: `text + entities[]`, offset UTF-16; URL trong entity/nút chỉ cho phép `http`, `https`, `mailto`, `{{scheme}}`; giới hạn độ dài đếm theo code point.
  - 0005 Fold tiếng Việt (đặc tả dưới).
  - 0006 Đăng nhập qua `hoandat-auth` và phiên chat (chi tiết ở bảng "Đăng nhập và phiên" dưới):
    - Không có đăng ký, mật khẩu, OTP hay 2FA trong app chat. Người dùng mới đăng ký ở IdP bằng `prompt=create`.
    - Danh tính chat là `(tenant_id, idp_sub)`, unique. `sub` (`acc_…`) không đổi khi user đổi email hay username.
    - Web: server làm OIDC Code + PKCE với client confidential `chat-web`. Native: app mở trình duyệt hệ thống, server đổi code với client public `chat-mobile` hoặc `chat-desktop`. Token IdP chỉ nằm ở server (mã hoá cột), không bao giờ xuống client.
    - Phiên chat: web dùng cookie `__Host-` HttpOnly, Secure, SameSite=Strict. Mọi RPC thay đổi trạng thái và WS handshake kiểm tra `Origin` theo allowlist của tenant. Native lưu token phiên trong Keychain/Keystore (Capacitor) và OS keyring (Tauri).
    - Phiên chat chết theo grant IdP: nhận back-channel logout (theo `sid`) hoặc refresh IdP trả `invalid_grant` thì thu hồi phiên và phát `session_revoked` để gateway đóng socket.
  - 0010 Tenant theo domain (theo ADR 0006 của `hoandat-auth`):
    - Mỗi tenant `<d>` có issuer `https://auth.<d>` và host chat `chat.<d>`. Tenant chính là `hoandat.com`.
    - `tenant_id` có trên `users`, `chats`, `bots`, `incoming_hooks` và mọi chỉ mục unique liên quan (username, invite link, bot username). Không có chat, tin, bot hay tìm kiếm xuyên tenant.
    - Chọn tenant theo Host ở lớp ngoài cùng; host lạ, tenant bị đình chỉ hoặc tenant chưa bật chat ở `/admin` của IdP trả `421`. Discovery, JWKS và trạng thái tenant lấy qua API nội bộ của IdP, cache theo tenant, dùng bản cũ khi IdP lỗi, không tin DNS công khai của tenant.
    - Secret của `chat-web` cho tenant tự tính bằng `base64url(HMAC-SHA256(<khoá app chat-web>, tenantId))`, giống Localman và Tunelo.
  - 0007 Topology client theo nền tảng: web — worker sở hữu transport, sync, SQLite (OPFS); Capacitor/Tauri — sync engine chạy trên main thread nhưng mọi thao tác nặng (ghi batch SQL, decode protobuf lô lớn) đẩy xuống native qua một lời gọi batch; UI chỉ nhận thay đổi gom theo frame ở cả hai topology.
  - 0008 Branding và quy ước đặt tên. Tên hiển thị của tenant lấy từ IdP (`displayName`), không phải từ `brand.config`.
  - 0009 Lưu trữ local: DB local mã hoá trên mobile/desktop (SQLCipher trên Capacitor, khoá trong Keychain/Keystore; Tauri dùng SQLCipher qua rusqlite, khoá trong OS keyring); web không mã hoá DB local (dữ liệu là cache, xoá khi đăng xuất).
- Spec fold + ≥ 300 test vector; TS và Go cùng pass.
- `brand.config.json`: tên app, short name, màu, icon, bundle id iOS/Android/Tauri, URL scheme, domain gốc của tenant chính (`hoandat.com`), mẫu host theo tenant (bảng "Host theo tenant" dưới), domain media dùng chung, issuer IdP của tenant chính, tên người gửi push. Bỏ tên người gửi email vì app không gửi email.
- Docker Compose dev: Postgres 17 (một primary + một sync standby để test epoch), Redis, Meilisearch, MinIO, và IdP `hoandat-auth` build từ repo bên cạnh (MongoDB riêng, Google/GitHub giả như bộ e2e của IdP) với hai tenant thử để test chọn tenant theo Host.

Non-functional:
- Không có chuỗi "chat-inet" trong code sản phẩm, UI hay identifier.
- CI: lint + typecheck + test (TS, Go), `buf lint` + `buf breaking`, so kết quả fold TS/Go, kiểm id < 2^53 ở serializer.

## Architecture

Đăng nhập và phiên:

| Nền tảng | Client IdP | Luồng | Redirect | Thời hạn phiên chat |
|---|---|---|---|---|
| Web | `chat-web` (confidential, `client_secret_basic`) | Code + PKCE do server làm, scope `openid profile email`, gửi `ui_locales` | `https://chat.<d>/auth/callback`; back-channel logout `https://chat.<d>/auth/backchannel-logout` | Theo grant IdP gắn phiên trình duyệt: trượt 30 ngày, trần 90 ngày |
| iOS/Android (Capacitor) | `chat-mobile` (public, native) | Code + PKCE qua ASWebAuthenticationSession / Custom Tabs; app gửi `code` + `code_verifier` cho `auth.ExchangeNativeCode` | Private-use scheme `{{scheme}}:/auth/callback` (Universal Links không dùng được vì domain tenant không biết trước lúc build) | Grant theo thiết bị, refresh token cấp theo chính sách client (không cần `offline_access`/`prompt=consent`): trượt 30 ngày, không trần 90 ngày (như `tunelo-cli`), thu hồi từng máy ở `/account`; mỗi lần đăng nhập trên máy, IdP hiện trang duyệt first-party (oidc-provider luôn hỏi với client native) |
| Desktop (Tauri) | `chat-desktop` (public, native) | Như mobile, mở trình duyệt hệ thống | Loopback `http://127.0.0.1:<cổng ngẫu nhiên>/auth/callback` (RFC 8252) | Như mobile |

- Lần đầu đăng nhập: tạo user chat với `preferred_username` của IdP làm username (đổi được trong chat nếu chưa trùng), `name` và `picture` làm hồ sơ ban đầu. Email lấy từ claim `email` chỉ khi `email_verified=true`; đọc lại mỗi lần đăng nhập và mỗi lần refresh, vì IdP có thể gỡ email của tài khoản.
- Kiểm grant còn sống: refresh token IdP (dùng một lần, xoay vòng) được refresh dưới mutex theo phiên khi client kết nối lại WS mà lần kiểm trước đã quá 1 giờ, và bởi job nền mỗi 24 giờ. `invalid_grant` thì thu hồi phiên. Web còn có back-channel logout nên thu hồi gần như tức thì; native phụ thuộc chu kỳ kiểm (tối đa 1 giờ khi đang dùng).
- Backend gọi token endpoint của IdP thẳng qua loopback (`http://127.0.0.1:<cổng IdP>` với `Host: auth.<d>`), dùng hạn mức riêng của IdP cho request loopback; discovery và JWKS lấy qua API nội bộ.
- Đăng xuất: xoá phiên chat, thu hồi refresh token ở `revocation_endpoint`; web chuyển tới `end_session_endpoint` với `id_token_hint`.
- Thao tác nhạy cảm (cấp lại token bot, xoá tài khoản, thu hồi mọi phiên khác) cần đăng nhập IdP trong 10 phút gần đây: gửi `prompt=login` + `max_age=600` và kiểm `auth_time`.

Host theo tenant (`<d>` là domain của tenant, `hoandat.com` với tenant chính):

| Host | Việc |
|---|---|
| `chat.<d>` | Web app, RPC, WS, callback OIDC, back-channel logout, deep link `/b/<username>` |
| `bot.chat.<d>` | Bot API |
| `chat.<d>/hook/*` | Incoming webhook trên host chat (location riêng ở nginx, redact `/hook/*`); không dùng `hook.chat.<d>` vì SSL miễn phí của Cloudflare chỉ phủ một cấp subdomain |
| `b<bot_id>.{{miniapp_domain}}` | Origin riêng cho từng Mini App; domain đăng ký riêng, dùng chung mọi tenant (`bot_id` unique toàn hệ thống) |
| `{{media_domain}}` | Media; domain đăng ký riêng, dùng chung mọi tenant, cookieless, token tải xuống có `tenant_id` |

Host của tenant nằm trong `chat.<d>` và `*.chat.<d>` (một cấp), cùng quy ước với `localman.<d>`/`*.localman.<d>` của hệ sinh thái nên dùng chung cơ chế cấp chứng chỉ của tenant. Mini App và media cố ý không nằm dưới `<d>`: cùng registrable domain với `chat.<d>` là same-site, nên request từ nội dung bên thứ ba sẽ mang cookie SameSite của app.

```
<repo>/
├─ apps/{web,mobile,desktop}/
├─ packages/
│  ├─ core/ ui/ platform/ platform-web/ platform-capacitor/ platform-tauri/
│  ├─ proto-ts/ brand/ miniapp-sdk/
├─ proto/app/v1/        # auth, users, chats, messages, updates, media, realtime, search, bots, config (*.proto)
├─ server/              # Go module: cmd/server (một binary, chạy theo role) + internal/
├─ sdk/{ts,python,go}/  # SDK bot (Phase 15)
├─ spec/{vi-fold,bot-api}/
├─ conformance/ load/
├─ deploy/{dev,k8s,observability,canary}/
├─ brand.config.json
└─ docs/{adr,operations,integrations,bot-api,privacy}/
```

Contract ID:

| Định danh | Nội bộ | Ra ngoài |
|---|---|---|
| user_id | int64 < 2^53, có bit shard | số < 2^53 |
| chat_id | int64 < 2^53; mọi chat (kể cả 1-1) có chat_id riêng | số < 2^53 + `type` (`private`, `group`, `channel`, `secret`) — cùng tên `type` ở DB, proto, JSON |
| message | Snowflake int64 (khoá lưu trữ, search) | `(chat_id, seq)`, `seq` < 2^53 |
| update | `pts` per-user, `chat_pts` per-chat lớn, kèm `server_epoch` | `pts` + `server_epoch`; `update_id` < 2^53 theo bot |
| file | uuid nội bộ | `file_id` gắn với chủ thể sở hữu + `file_hash` ổn định |
| bot token | hash lưu DB | chuỗi opaque có tiền tố theo brand |

`Message` proto gồm: `chat_id`, `seq`, `from_id`, `date`, `text`, `entities[]`, `media` (file_id, width, height, duration, inline_thumb), `reply_to_seq`, `forward_from`, `edit_date`, `edit_version`, `random_id`, `reply_markup` (reply keyboard / inline keyboard / remove), `grouped_id` (album), `via_bot_id`, `reactions` (tổng hợp), `integration_label` (tin từ webhook).

RPC theo domain (đầy đủ cho v1):
- `auth`: `GetAuthConfig` (issuer, `client_id`, tên tenant cho client native), `ExchangeNativeCode`, `SignOut`, `ListSessions`, `RevokeSession`, `RevokeOtherSessions`. Web đăng nhập bằng route HTTP `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/backchannel-logout`, không qua RPC.
- `users`: `GetUsers`, `UpdateProfile`, `SetUsername`, `ResolveUsername`, `SearchUsers`, `Block`, `Unblock`, `GetPrivacy`, `SetPrivacy`.
- `chats`: `CreatePrivate`, `CreateGroup`, `CreateChannel`, `GetDialogs`, `GetChat`, `GetMembers`, `AddMembers`, `RemoveMember`, `LeaveChat`, `SetMemberPermissions`, `SetAdmin`, `ExportInviteLink`, `JoinByInvite`, `SetHistoryVisibility`, `UpdateChatInfo`.
- `messages`: `SendMessage`, `SendMedia`, `SendAlbum`, `ForwardMessages`, `CopyMessage`, `EditMessage`, `DeleteMessages` (cho mình/mọi người), `ReadHistory`, `PinMessage`, `UnpinMessage`, `SetReaction`, `GetHistory`, `PressInlineButton`.
- `updates`: `GetState`, `GetDifference`, `GetChatDifference`.
- `media`: `CreateUpload`, `CompleteUpload`, `AbortUpload`, `GetFileUrl`.
- `realtime`: frame WS (`Hello`, `Update`, `Typing`, `Presence`, `OpenChat`, `SessionRevoked`, `Resync`).
- `search`: `SearchMessages` (cursor-based), `SearchChatMessages`.
- `config`: `GetAppConfig(hash)` (giới hạn và timer theo tenant, Phase 2).
- `bots`: `InlineQuery`, `OpenMiniApp`, `StartBot`.

Đặc tả fold (ADR 0005): NFC → lowercase → NFD → bỏ mọi ký tự General Category `Mn` (gồm dấu thanh, dấu mũ, dấu móc ơ/ư, dấu trăng ă) → `đ→d` → NFC → gộp khoảng trắng → tách token theo Unicode word boundary.

## Related Code Files

Create:
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.editorconfig`, `.gitignore`
- `proto/buf.yaml`, `proto/buf.gen.yaml`, `proto/app/v1/{auth,users,chats,messages,updates,media,realtime,search,bots,config}.proto`
- `server/go.mod`, `server/cmd/server/main.go`, `server/internal/{ids,vifold,entities,protoids}/` (`server/internal/tenant` làm ở Phase 2)
- `packages/core/src/{vifold,ids,entities}/`, `packages/proto-ts/`, `packages/brand/`
- `spec/vi-fold/{SPEC.md,test-vectors.json}`
- `brand.config.json`, `brand.config.schema.json`
- `deploy/dev/docker-compose.yml`
- `docs/adr/0001-…` → `0010-…`, `docs/README.md`, `docs/integrations/hoandat-auth.md`
- `.github/workflows/ci.yml`

## Implementation Steps

1. Khởi tạo monorepo pnpm (TS strict, ESLint `--max-warnings=0`, Vitest) và Go module (`golangci-lint`); khai báo mọi thư mục cấp cao trong `pnpm-workspace.yaml`.
2. Viết ADR 0001–0010; review chéo với người phụ trách backend, client, bảo mật. ADR 0006 và 0010 đối chiếu với `hoandat-auth/docs/integration-guide.md`.
3. Mở plan ở repo `hoandat-auth` cho các thay đổi phía IdP (mục "Thay đổi cần làm ở hoandat-auth" trong `plan.md`); Phase 2 chỉ tích hợp đăng nhập thật khi client `chat-web` đã có ở môi trường staging của IdP.
4. Viết proto theo domain và RPC đầy đủ ở trên; `buf lint`, bật `buf breaking`.
5. Spec fold + ≥ 300 test vector (đủ ă â ê ô ơ ư đ, chữ hoa/thường, NFD đầu vào, emoji, lẫn tiếng Anh); implement TS và Go.
6. Helper entities UTF-16 + validate scheme URL; test emoji nhiều code unit và scheme `javascript:`, `file:`, `ms-msdt:` bị từ chối.
7. ID helpers: Snowflake, cấp id có bit shard, assert < 2^53 ở serializer proto và JSON.
8. `brand.config` + JSON Schema + generator cho manifest web/Capacitor/Tauri; lint rule chặn tên sản phẩm cứng.
9. Docker Compose dev (có sync standby và IdP local hai tenant).
10. GitHub Actions cho mọi kiểm tra ở trên (repo GitHub private `achoo254/chat-next`, giống `localman-next`).

## Todo

- [x] Monorepo + Go module + quy ước `@app/*`
- [x] ADR 0001–0010 (0006 đăng nhập qua `hoandat-auth`, 0010 tenant)
- [x] Plan phía `hoandat-auth` cho client chat và host `chat.<d>`
- [x] Proto theo domain, RPC đầy đủ, codegen Go/TS
- [x] Spec fold + ≥ 300 vector, TS và Go cùng pass
- [x] Entities UTF-16 + allowlist scheme
- [x] ID helpers + assert < 2^53
- [x] `brand.config` + generator + lint
- [ ] Docker Compose dev (đã viết và kiểm cú pháp; chưa chạy vì máy dev không có Docker; tenant thứ hai cần script seed ở `hoandat-auth` Phase 02)
- [x] CI GitHub Actions xanh (run 38537735232: `typescript`, `proto`, `go` đều pass)

## Success Criteria

- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` và `cd server && go test ./...` pass, 0 warning.
- `buf lint` pass; `buf breaking` chạy trong CI.
- Cùng `test-vectors.json` cho kết quả giống hệt ở TS và Go; "Người đẹp Đà Nẵng", "Ưu đãi", "Ăn" fold đúng.
- Đổi `appName` rồi build lại thì manifest đổi theo; `grep -ri "chat-inet" apps packages server proto` rỗng.
- Proto `auth` không còn RPC email, OTP hay 2FA; mọi bảng có danh tính hoặc chỉ mục unique theo người dùng đều có `tenant_id` ngay ở migration đầu.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm -r test`
- `cd server && go vet ./... && go test ./...`
- `cd proto && buf lint && buf breaking --against '.git#branch=main'`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Thiếu trường proto, phải phá vỡ sau | Cao | `buf breaking`; chỉ thêm trường |
| ADR topology native chưa kiểm chứng trên thiết bị | Trung bình | Spike Capacitor/Tauri ngay đầu Phase 5 trước khi đóng `packages/core` |
| Thay đổi phía `hoandat-auth` (client native, host `chat.<d>`, API nội bộ từ xa) chưa xong khi Phase 2 cần | Cao | Mở plan bên IdP ngay ở Phase 1; Phase 2 dùng IdP chạy local từ repo `hoandat-auth` (`docker compose up`) cho test tích hợp |

## Security Considerations

- `.gitignore` chặn `.env*`, keystore, provisioning profile, `*.p8`, `*.p12`.
- ADR 0004 và 0006 là nền cho chống XSS, CSRF, CSWSH.
- Khoá app `chat-web` (suy ra secret theo tenant) và secret client của tenant chính nằm trong secret store, không bao giờ vào repo hay log.

## Rollback

Chỉ tạo file mới trong repo trống; rollback bằng `git revert`.

## Next Steps

Phase 2 dùng proto, ADR 0001–0003, 0006, 0010; Phase 5 dùng ADR 0006, 0007, 0009.

## Kết quả (2026-10-14)

Chưa commit (repo chưa có remote). Cổng kiểm cục bộ:
- `pnpm lint` (ESLint `--max-warnings=0` + `check-brand`), `pnpm typecheck`: sạch.
- `pnpm test`: `@app/core` 632 test (390 vector fold, test FTS5 thật trên `node:sqlite`, vector entities/URL/link, ID), `@app/brand` 7 test.
- `go vet ./...`, `gofmt -l`: sạch; `go test -race -count=1 ./...`: 5 package pass (gồm `protoids`: kiểm id < 2^53 khi serialize và mọi trường int64 có `JS_NUMBER`); `golangci-lint run`: 0 issue.
- `buf lint proto`: sạch; sinh lại code cho kết quả trùng checksum 20 file đã có. `buf breaking` chưa có baseline vì `main` chưa có proto; CI bỏ qua bước này tới khi có.

Quyết định phát sinh khi làm (Jev quyết ngày 2026-10-14, ghi vào ADR):
- protobuf-es sinh `bigint` cho int64 dù có `jstype = JS_NUMBER`; giữ protobuf-es và đổi sang `number` ở lớp ánh xạ của core (Jev 1.00).
- Partition outbox giữ 30 ngày (Jev 0.94).
- IdP đọc redirect mobile từ `CHAT_MOBILE_REDIRECT_URI` (Jev 0.92; commit `4a9ca7d` ở `hoandat-auth`).
- Năm RPC còn thiếu (`CheckInvite`, danh sách đã đọc, `SendInlineResult`, menu lệnh bot, quản lý bot) thêm ở phase sở hữu, đã ghi vào Phase 2 và 8 (Jev 1.00).
- Tách token của fold theo UAX #29 có quy tắc riêng cho chữ Hán, Nhật, Hàn và Đông Nam Á để `Intl.Segmenter` (ICU) và `uniseg` (Go) cho cùng kết quả (`spec/vi-fold/SPEC.md` mục 3.3). Nhóm ký tự Prepend thuộc `Cf` được loại trừ vì bảng Unicode của Go và ICU khác phiên bản.
- `brand.config.json`: `sharedDomains` cho media và Mini App đang để giá trị `.invalid`; tên domain thật chọn khi làm Phase 4 (release R3) và Phase 16 (release R6).
- Review độc lập (15 điểm) đã sửa: CI cài Go cho job proto và lấy baseline `buf breaking` đúng; index và truy vấn tìm kiếm dùng `searchText` với tokenizer FTS5 cố định (SPEC §4); proto thêm `large_chats`, `Message.action`, bỏ `client_id` và `end_session_url`; Compose healthcheck qua TCP, standby tự khởi động lại, có replication slot; allowlist chặn link `/auth/` và URL có userinfo; Snowflake dùng đồng hồ monotonic; id 0 bị từ chối; Capacitor giữ origin `localhost`.

