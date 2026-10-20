---
phase: 11
title: "Phase 11: Ứng dụng desktop bằng Tauri v2"
status: pending
priority: P2
effort: "L"
dependencies: [3, 6]
principles: [4, 2, 3]
---

# Phase 11: Ứng dụng desktop bằng Tauri v2

> **Huỷ 20/10/2026: desktop = PWA.** Không làm phase này: toàn hệ sinh thái không có app desktop native (`hoandat-app/docs/ecosystem-architecture.md` §3, §4). Máy tính dùng bản web cài dạng PWA; client `chat-desktop` đã gỡ khỏi IdP. Nội dung bên dưới giữ làm lịch sử.

<!-- Updated: Red Team 2026-10-13 - spike WS bằng Rust làm dự phòng throttling, SQLCipher + keyring, cửa sổ Mini App không capability, opener allowlist scheme -->
<!-- Updated: Validation Session 2 2026-10-14 - đăng nhập qua hoandat-auth bằng trình duyệt hệ thống + loopback, chọn tenant -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - data store riêng cho từng Mini App, thông báo có đánh dấu đã đọc/trả lời, xoá khi đọc nơi khác, id theo tenant, badge gộp -->
<!-- Updated: Validation Session 8 2026-10-14 - Mini App chuyển sang Phase 16 -->

## Goal

Đóng gói web app cho macOS, Windows, Linux với trải nghiệm desktop đầy đủ: luôn nhận tin khi thu nhỏ vào tray, thông báo hệ thống, deep link, tự cập nhật.

## Context Links

- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 2.2, 3.3, 6 (bài học Cinny Desktop)
- [Kỹ thuật tốc độ client web](../reports/researcher-261013-1120-telegram-web-client-speed.md) — telegram-tt bản Tauri tải web app từ URL remote

## Key Insights

- Tauri chưa có plugin push; desktop giữ WebSocket khi chạy nền.
- Cửa sổ ẩn có thể bị throttle sau khoảng 5 phút; `backgroundThrottling` chỉ chạy trên macOS 14+, Windows/Linux cần workaround (Web Lock giữ hoạt động) — rủi ro lớn nhất của client desktop.
- Dùng `rusqlite` (SQLCipher, ADR 0009) + command batch thay vì `tauri-plugin-sql` (chưa hỗ trợ transaction); `invoke` không gọi được từ Worker nên theo topology native của ADR 0007.
- Web Push không có trong WebView2/WKWebView nhúng/WebKitGTK; phương án dự phòng thật cho throttling là **chuyển WebSocket và thông báo xuống Rust**.
- Danh sách issue được vote nhiều của Cinny Desktop là checklist những gì bọc web chat trong Tauri không tự có: tray, dán ảnh từ clipboard, quyền thông báo, mở link ngoài.

## Requirements

Functional:
- `apps/desktop` + `@app/platform-tauri`: driver SQLCipher (rusqlite, batch), token phiên chat trong OS keyring, `AuthBrowser`, thông báo hệ thống, tray + badge, autostart tuỳ chọn, single instance, deep link (`{{scheme}}://`), dán ảnh từ clipboard, kéo thả file, mở link ngoài bằng trình duyệt mặc định **sau khi kiểm allowlist scheme (ADR 0004)**, updater có chữ ký.
- Đăng nhập qua IdP `hoandat-auth` theo ADR 0006 (client `chat-desktop`): mở trình duyệt mặc định của hệ thống; Rust mở listener loopback `127.0.0.1` cổng ngẫu nhiên chỉ cho một callback, kiểm `state`, đóng ngay sau khi nhận hoặc sau 10 phút; không mở trang IdP trong WebView của app.
- Chọn tenant như mobile ("Đăng nhập bằng domain khác"); DB và keyring tách theo `(tenant, user)`.
- Cửa sổ Mini App (riêng, không capability, data store riêng theo bot) làm ở Phase 16.
- Giữ kết nối khi thu nhỏ; khi thức dậy từ sleep thì GetDifference.
- Tên app, identifier, icon, scheme từ `brand.config`.
- Thông báo hệ thống:
  - Có nút "Đánh dấu đã đọc" và "Trả lời" (ô nhập) trên macOS/Windows khi native hỗ trợ; Linux tuỳ môi trường desktop; có tuỳ chọn ẩn nút trả lời.
  - Nhận update `read` (hoặc `read_inbox_max_seq`) qua WS thì xoá các thông báo hệ thống của chat đó, kể cả khi đọc ở thiết bị khác.
  - Giữ thông báo một khoảng ngắn (giá trị từ `GetAppConfig`) trước khi hiện, huỷ nếu trong lúc đó nhận `read` của chat.
  - Id thông báo mang `(tenant, user, chat_id, seq)` để bấm vào mở đúng tenant và chat.
- Badge cộng mọi `(tenant, user)` đang đăng nhập, có debounce, tuỳ chọn tính cả chat tắt tiếng.

Non-functional:
- Cold start ≤ 400 ms tới danh sách chat từ cache trên máy chuẩn.
- Tin tới khi cửa sổ ẩn > 30 phút vẫn hiện thông báo trong ≤ 2 s.

## Related Code Files

Create:
- `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,src/db.rs,src/tray.rs}`
- `apps/desktop/src/main.ts`
- `packages/platform-tauri/src/{driver,notify,tray,deeplink,updater,lifecycle,auth-browser}.ts`
- `apps/desktop/src-tauri/src/auth_loopback.rs`

## Implementation Steps

1. **Spike đầu phase**: ẩn cửa sổ 30 phút trên Windows/Linux với (a) Web Lock workaround và (b) WS client trong Rust phát thông báo native; chọn phương án đạt ngân sách.
2. Khởi tạo Tauri v2, bundle local (chạy offline).
3. Command Rust cho SQLCipher (`exec_batch`, `query`), khoá trong keyring, migrations dùng chung.
4. Thông báo, tray, badge, single instance, autostart, deep link.
5. Áp dụng phương án throttling đã chọn ở spike (`backgroundThrottling` trên macOS 14+).
6. Clipboard ảnh, kéo thả, mở link ngoài qua allowlist.
7. Updater có chữ ký; build và ký trên GitHub Actions (Developer ID + notarize cho macOS, code signing Windows).

## Todo

- [ ] Spike throttling (Web Lock vs WS trong Rust)
- [ ] Tauri v2 + startApp
- [ ] SQLCipher qua rusqlite + keyring
- [ ] Notify/tray/badge/single instance/autostart/deep link
- [ ] Áp dụng phương án throttling + test 30 phút
- [ ] Clipboard/kéo thả/link ngoài qua allowlist
- [ ] Updater + ký số CI

## Success Criteria

- Trên macOS, Windows, Linux: thu nhỏ vào tray 30 phút rồi nhận tin → thông báo hiện trong ≤ 2 s.
- Cập nhật tự động từ bản N lên N+1 thành công trên cả ba hệ điều hành.

## Verification

- `pnpm --filter @app/desktop tauri build`
- Checklist thủ công 3 hệ điều hành, lưu kết quả khi chạy phase.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Throttle cửa sổ ẩn trên Windows/Linux | Cao | Spike đầu phase; dự phòng là WS + thông báo trong Rust |
| Khác biệt WebView giữa các OS (WebView2, WKWebView, WebKitGTK) | Trung bình | E2E trên cả ba |

## Security Considerations

- Capability Tauri tối thiểu, chỉ cấp cho cửa sổ chính; cửa sổ Mini App không có capability; CSP chặt.
- Link `file:`, `smb:`, `ms-msdt:` bị chặn trước khi gọi opener (test tự động).
- Khoá ký updater lưu trong secret CI.

## Rollback

Updater cho phép phát hành bản sửa; giữ bản trước trên kênh phát hành để người dùng cài lại.

## Next Steps

Phase 14 đưa desktop vào kiểm thử phát hành.
