---
phase: 16
title: "Phase 16: Mini App"
status: in-progress
priority: P1
effort: "L"
dependencies: [8, 15]
principles: [6, 5, 3]
---

# Phase 16: Mini App

<!-- Created: Validation Session 8 2026-10-14 - user dời Media và Mini App xuống cuối lộ trình; gom mọi phần Mini App đang rải ở Phase 1, 8, 10, 11, 12, 13, 15 về đây -->
<!-- Updated: Validation Session 9 2026-10-14 - không còn làm sau cùng: web ở R6, mobile R7, desktop R8 -->

## Goal

Cho bot mở một ứng dụng web nhỏ (Mini App) ngay trong chat, ở origin riêng của từng bot, với dữ liệu khởi tạo có chữ ký để bot tin được người dùng, mà không cho Mini App chạm vào phiên, cookie hay quyền hệ thống của app chat.

## Thứ tự

Mini App trên web lên prod ở release R6, ngay sau release bot (R5). Phần mobile và desktop của Mini App lên cùng release mobile (R7) và desktop (R8). Mini App được gom vào một phase riêng để review và deploy thành một lát trọn vẹn; contract proto (`OpenMiniApp`, nút mở Mini App) đã có từ Phase 1.

## Context Links

- [Phase 8](./phase-08-bot-platform.md) (Bot API, mục Security về Mini App), [Phase 10](./phase-10-mobile-capacitor.md), [Phase 11](./phase-11-desktop-tauri.md), [Phase 15](./phase-15-bot-sdk-developer-console.md)
- ADR 0004 (allowlist link), ADR 0010 (Mini App ở URL của người viết bot, không dưới domain app hay tenant)
- Mock: [`mockups/bots.html#mini-app`](./mockups/bots.html), `#mini-app-permission`, [`mockups/mobile.html#mini-app`](./mockups/mobile.html), [`mockups/desktop.html#mini-app-window`](./mockups/desktop.html), [`mockups/console.html#mini-app-settings`](./mockups/console.html)

## Requirements

Functional:
- Mini App là URL https do chủ bot đăng ký, trên domain của họ, như Telegram (quyết định 2026-10-19, Jev 0,95; thay cho domain riêng do chat phục vụ, nên không cần mua domain hay chứng chỉ wildcard). Server từ chối URL không phải https, có thông tin đăng nhập trong URL, trỏ vào IP riêng, hoặc nằm dưới domain của app hay của bất kỳ tenant nào (cùng site với app).
- Bot API: nút mở Mini App trong reply/inline keyboard, `OpenMiniApp`; dữ liệu khởi tạo ký HMAC và Ed25519, có `auth_date`, `tenant_id`; khoá ký Mini App dẫn xuất lúc phát hành token bot, lưu `miniapp_key_enc` mã hoá bằng KMS, vô hiệu cùng token cũ (`server/internal/miniapp`).
- Bridge (`packages/miniapp-sdk`): tập sự kiện v1 là enum cố định (`ready`, `close`, `viewport`, `theme`, `main_button`, `back_button`, `open_link`, `open_popup`, `data_send`, `request_write_access`, `invoke_custom_method`); sự kiện lạ bị bỏ và log; mỗi message có trần kích thước và được kiểm schema; URL từ Mini App qua allowlist ADR 0004.
- Web: iframe `sandbox="allow-scripts allow-forms allow-same-origin"` (origin là domain của người viết bot, khác site với app, nên Mini App dùng được cookie và storage của chính nó mà không chạm được của app); không có `allow-top-navigation`; bridge kiểm `event.origin` (đúng origin của URL đã đăng ký) và `event.source`.
- Mobile: Mini App mở trong in-app browser tách biệt, không trong WebView chính.
- Desktop: cửa sổ riêng, không capability Tauri nào; data store riêng theo bot.
- Developer Console: đăng ký URL Mini App (chỉ https), xem trước origin.
- SDK TS/Python/Go: hàm xác thực dữ liệu khởi tạo (HMAC và Ed25519), ví dụ Mini App, kịch bản conformance Mini App.
- Xin quyền: popup "cho phép nhắn tin" (write access) và cảnh báo trước khi mở link ngoài.

Non-functional:
- Mini App không đọc được cookie, storage hay phiên của app chat trên mọi nền tảng (test tự động).

## Hợp đồng R6 web (2026-10-19)

Quyết định của Jev: URL của người viết bot (0,95); chỉ ký Ed25519 (0,98), không HMAC theo token; bridge bản đầu là bộ lõi (0,85). Mobile/desktop để R7/R8.

- **URL Mini App.** Chính: `Bot.mini_app_url` (Console, `UpdateBotRequest.mini_app_url`), hiện ở `GetBotInfoResponse.mini_app_url` cho nút "Mở app". Phụ: nút inline `mini_app_url` (Bot API `web_app: {url}`). Kiểm ở server khi bot đặt: https, không user:pass, host không phải IP, không nằm dưới domain đăng ký của app (`PublicURL`) hay của bất kỳ tenant nào, dài tối đa 512.
- **Mở.** `OpenMiniApp(bot_id, chat_id, seq, url, start_param, theme_params)`: url rỗng là Mini App chính; url khác phải đúng `mini_app_url` của một nút trên tin `chat_id/seq` mà người gọi thấy được. Trả `url` và `init_data`.
- **init_data** là query string: `user` (JSON `{id, first_name, username}`), `chat_type` (`private`, `group`, `channel`, hoặc `sender` khi mở từ hồ sơ bot), `chat_instance` (chuỗi ổn định theo cặp chat và bot), `start_param`, `auth_date`, `bot_id`, `tenant_id`, `signature`. Chữ ký Ed25519 (base64url, không padding) trên chuỗi `"<bot_id>:WebAppData\n"` nối các trường còn lại dạng `key=value` theo thứ tự tên, cách nhau `\n` (như Telegram, bên thứ ba xác thực). Khoá riêng suy bằng HKDF-SHA256 từ `SESSION_KEY` (info `chat-miniapp-ed25519`), không thêm secret mới; xoay khoá phiên thì khoá ký đổi theo. Khoá công khai (32 byte, base64url): Bot API `getMiniAppKey` → `{"public_key": …}`. SDK TS/Python/Go có hàm xác thực (chữ ký, đúng `bot_id`, `auth_date` không quá 1 giờ).
- **Container web.** Khung bên phải (hẹp: toàn màn hình) do app vẽ đầu khung: tên bot, host thật của URL, đóng. Iframe `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` (không `allow-top-navigation`), `src` = URL + `#chatAppData=<init_data mã hoá URL>&chatAppTheme=<light|dark>`. Nút chính ở đáy do app vẽ.
- **Bridge.** Mini App gửi `window.parent.postMessage({type, data}, "*")`; app chỉ nhận khi `event.source` là iframe và `event.origin` đúng origin của URL; mỗi tin tối đa 4 KB, kiểm schema, kiểu lạ bị bỏ. Kiểu: `ready`; `close`; `main_button {text, visible, enabled}` (bấm gửi về `main_button_pressed`); `open_link {url}` (allowlist ADR 0004, hỏi trước khi mở tab mới); `request_write_access` (popup app vẽ; đồng ý gọi `AllowMiniAppWrite`; trả `write_access {granted}`); `data_send {data}` (`SendMiniAppData`, rồi đóng khung). App gửi xuống: `theme {scheme}` khi đổi giao diện, `main_button_pressed`, `write_access`. Script cho người viết Mini App: `https://chat.<d>/miniapp/sdk.js` (đối tượng `ChatApp`).
- **Dữ liệu về bot.** `SendMiniAppData` đăng tin từ người dùng vào chat riêng với bot, mang `ActionMiniAppData`; người dùng thấy "Đã gửi dữ liệu từ <nút> tới bot"; bot nhận `message.web_app_data {data, button_text}`.

## Security Considerations

- Xoay vòng khoá Mini App có runbook; khoá Mini App có trong data inventory và secret store.
- Review STRIDE riêng cho Mini App trước khi phát hành.

## Todo

- [x] Kiểm URL Mini App (https, không dưới domain đăng ký của app hay tenant, không IP, không user:pass); kiểm lại khi mở
- [x] Ký/xác thực dữ liệu khởi tạo — đổi so với bản đầu: chỉ Ed25519, khoá dẫn xuất từ `SESSION_KEY` (không theo token bot, không HMAC; Jev 0,98)
- [x] Bridge (`/miniapp/sdk.js`) + trần 4 KB + schema + không `allow-top-navigation`; link ngoài qua allowlist và hỏi trước
- [x] Container web (R6); in-app browser mobile (R7), cửa sổ desktop (R8) còn lại
- [x] Console: URL Mini App; SDK: helper xác thực ở TS/Python/Go
- [x] SDK: ví dụ `miniapp` ở TS/Python/Go + kịch bản conformance (ts, python, go × poll, webhook)
- [x] STRIDE (dưới) + test: server (`internal/miniapp`, `internal/api/miniapp_test.go`), web (`test/mini-app.test.tsx`), e2e trình duyệt thật (`bots.e2e.ts`: mở từ nút, xác thực init data bằng SDK, sửa một trường thì hỏng, nút chính gửi dữ liệu về bot)
- [x] Deploy root một lần (CSP `frame-src https:`, release `20261019-044627-2be451944f61`, migration 28, backup `chat-20261019-044646.dump`); kiểm CSP ở cả hai tenant, `/miniapp/sdk.js` 200, `/bot/v1/miniAppKey` không token 401, smoke ok
- [ ] Người dùng thử một Mini App thật trên prod

## STRIDE (R6 web, 2026-10-19)

- **Giả mạo:** init data ký Ed25519 trên mọi trường, gắn `bot_id`, `auth_date` quá 1 giờ bị SDK từ chối; app chỉ nghe tin từ đúng iframe (`event.source`) ở đúng origin của URL (`event.origin`) và chỉ gửi xuống origin đó.
- **Sửa đổi:** URL nút phải đúng `mini_app_url` của một nút trên tin `chat_id/seq` người gọi thấy được, của chính bot đó; server kiểm lại URL khi mở (tenant mới thêm sau cũng chặn được). Tin bridge sai schema, quá 4 KB hoặc kiểu lạ bị bỏ.
- **Chối bỏ:** `data_send` thành tin của người dùng trong chat riêng với bot ("Đã gửi dữ liệu từ … tới bot"), có trong lịch sử.
- **Lộ thông tin:** Mini App ở site khác app (kiểm URL theo domain đăng ký), nên không có cookie SameSite hay storage của app; init data nằm trong fragment (không tới server hay log của ai); `chat_instance` là HMAC, không lộ id chat; `user` chỉ có id, tên, username.
- **Từ chối dịch vụ:** `SendMiniAppData` đi qua giới hạn gửi tin, `AllowMiniAppWrite` qua giới hạn ghi; dữ liệu tối đa 4096 byte.
- **Leo quyền:** iframe không có `allow-top-navigation`; mở link phải qua allowlist ADR 0004 và người dùng bấm; quyền nhắn tin chỉ sau khi người dùng bấm "Cho phép"; `data_send` chỉ khi mở từ chat riêng với bot hoặc hồ sơ bot (client kiểm; phía server đây là lời gọi của chính người dùng vào chat riêng của họ, không vượt quyền).
- **Còn lại:** khoá ký đổi khi xoay `SESSION_KEY` (bot lấy lại khoá qua `getMiniAppKey` khi chữ ký không khớp); Python cần gói `cryptography` (extra tuỳ chọn).

## Success Criteria

- Dữ liệu khởi tạo bị sửa hoặc quá hạn `auth_date` bị từ chối; hợp lệ được chấp nhận (HMAC và Ed25519), ở server và ở cả ba SDK.
- Mini App không đọc được cookie hay storage của app chat và không điều hướng được cửa sổ chính ra ngoài origin của nó.
