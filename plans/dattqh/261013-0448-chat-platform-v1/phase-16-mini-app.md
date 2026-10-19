---
phase: 16
title: "Phase 16: Mini App"
status: pending
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

## Security Considerations

- Xoay vòng khoá Mini App có runbook; khoá Mini App có trong data inventory và secret store.
- Review STRIDE riêng cho Mini App trước khi phát hành.

## Todo

- [ ] Kiểm URL Mini App (https, không dưới domain app/tenant, không IP riêng)
- [ ] Ký/xác thực dữ liệu khởi tạo + khoá theo token bot
- [ ] Bridge SDK + giới hạn kích thước + schema + chặn điều hướng
- [ ] Container web, in-app browser mobile, cửa sổ desktop
- [ ] Console: URL Mini App; SDK: helper + ví dụ + conformance
- [ ] STRIDE + test cô lập

## Success Criteria

- Dữ liệu khởi tạo bị sửa hoặc quá hạn `auth_date` bị từ chối; hợp lệ được chấp nhận (HMAC và Ed25519), ở server và ở cả ba SDK.
- Mini App không đọc được cookie hay storage của app chat và không điều hướng được cửa sổ chính ra ngoài origin của nó.
