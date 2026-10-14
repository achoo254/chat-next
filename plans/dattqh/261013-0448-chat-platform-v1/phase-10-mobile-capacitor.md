---
phase: 10
title: "Phase 10: Ứng dụng mobile bằng Capacitor"
status: pending
priority: P1
effort: "L"
dependencies: [3, 6]
principles: [4, 2, 3]
---

# Phase 10: Ứng dụng mobile bằng Capacitor

<!-- Updated: Red Team 2026-10-13 - native batch bridge (ADR 0007), SQLCipher (ADR 0009), payload push mã hoá, xoá thông báo best-effort, OTA ký số self-host, Mini App in-app browser, allowlist scheme -->
<!-- Updated: Validation Session 2 2026-10-14 - đăng nhập qua hoandat-auth bằng trình duyệt hệ thống + private-use scheme, một bản app cho mọi tenant -->
<!-- Updated: Validation Session 8 2026-10-14 - Mini App chuyển sang Phase 16 -->

## Goal

Đóng gói web app thành ứng dụng iOS và Android cảm giác native: mở nhanh từ cache, nhận thông báo tin cậy, bắt kịp tin ngay khi quay lại app.

## Context Links

- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 2.2, 3.1, 3.2, 4, 5

## Key Insights

- Không giữ WebSocket khi app chạy nền; dựa vào push, khi resume thì kết nối lại và GetDifference.
- Capacitor push plugin không có silent push trên iOS; notification service extension (Swift) và FirebaseMessagingService (Kotlin) phải viết native để hiển thị nội dung, badge, gộp thông báo.
- SQLite native (`@capacitor-community/sqlite`, build SQLCipher theo ADR 0009) để extension native đọc được DB khi cần.
- Plugin không gọi được từ Worker (ADR 0007): sync engine chạy main thread, ghi/decode lô lớn qua **một** lời gọi native batch.
- iOS không giao push nền cho app bị tắt; xoá thông báo chéo thiết bị là best-effort, NSE dọn thông báo cũ dựa trên `read_inbox_max_seq` trong mỗi push.
- Không tìm thấy app chat production công khai dùng Capacitor: đây là rủi ro, cần thử nghiệm sớm trên thiết bị thật.
- iOS dùng SPM ngay từ đầu (CocoaPods trunk chuyển read-only từ 02/12/2026).
- OTA (Capgo) chỉ cho sửa lỗi và chỉnh UI để tuân thủ chính sách App Store/Google Play.

## Requirements

Functional:
- `apps/mobile` với `@app/platform-capacitor`: driver SQLCipher native có lệnh batch, SecureStore (Keychain/Keystore), `AuthBrowser`, push, keyboard, lifecycle, share sheet, ảnh/camera, deep link, `OpenExternal` kiểm allowlist scheme (ADR 0004).
- iOS Notification Service Extension + Android messaging service: giải mã payload bằng khoá thiết bị (khoá trong Keychain/Keystore), hiển thị tên người gửi và xem trước (nếu bật), gộp theo chat, badge từ server, dọn thông báo đã đọc theo `read_inbox_max_seq`; Android dùng `tag` theo chat để thay thông báo.
- Đăng nhập qua IdP `hoandat-auth` theo ADR 0006 (client `chat-mobile`):
  - `AuthBrowser` dùng ASWebAuthenticationSession (iOS) và Custom Tabs (Android), không bao giờ mở trang IdP trong WebView của app. Phiên IdP trong trình duyệt hệ thống được giữ để lần sau không phải đăng nhập lại Google/GitHub.
  - Redirect là private-use scheme `{{scheme}}:/auth/callback`. Handler deep link chỉ nhận callback khi đang có một lần đăng nhập chờ với `state` khớp; callback lạ bị bỏ qua.
  - Thu hồi thiết bị ở `/account` của IdP hoặc nhận `SessionRevoked` thì app xoá DB, cache và token của tenant đó.
- Một bản app cho mọi tenant: màn hình đăng nhập có "Đăng nhập bằng domain khác"; push payload mang `tenant_id` để mở đúng DB và chat; một project APNs/FCM dùng chung.
- Mini App (in-app browser tách biệt) làm ở Phase 16.
- OTA: Capgo **self-host tại Việt Nam**, bundle ký bằng khoá riêng (lưu Vault), app chỉ nhận bundle có chữ ký hợp lệ và khớp `min_native_version`; phát hành OTA cần 2 người phê duyệt qua GitHub environment có required reviewers; chỉ dùng cho sửa lỗi và chỉnh UI.
- Lifecycle: pause → đóng WS; resume → snapshot + GetDifference.
- Bundle id, tên app, icon, splash sinh từ `brand.config`.

Non-functional:
- Cold start tới danh sách chat ≤ 1 s trên Android tầm trung (ví dụ Galaxy A-series đời gần nhất) và iPhone đời cũ nhất còn hỗ trợ.
- Cuộn mượt ≥ 55 fps trên cùng thiết bị.

## Related Code Files

Create:
- `apps/mobile/{capacitor.config.ts,src/main.ts,ios/,android/}`
- `apps/mobile/ios/NotificationService/` (Swift)
- `apps/mobile/android/app/src/main/java/.../MessagingService.kt`
- `packages/platform-capacitor/src/{driver,push,lifecycle,keyboard,files,deeplink,auth-browser}.ts`

## Implementation Steps

1. Khởi tạo Capacitor 8 (SPM cho iOS), nối `startApp(capacitorPlatform)`.
2. Driver SQLCipher native theo `SqlDriver` + lệnh batch (ghi + decode lô), chạy chung migrations; kiểm tra FTS5 trong build SQLCipher (`PRAGMA compile_options`) trên iOS và Android.
3. Push: đăng ký token APNs/FCM, gửi lên server; xử lý mở thông báo → điều hướng tới chat.
4. Notification Service Extension (iOS) và messaging service (Android): giải mã payload, dọn thông báo đã đọc, đăng ký khoá công khai thiết bị lên server.
5. Lifecycle + keyboard + safe area.
6. Sinh cấu hình từ `brand.config`; ký số và build qua GitHub Actions (fastlane match cho iOS, keystore + Play App Signing cho Android).
7. Capgo self-host + ký bundle + kiểm chữ ký trong app + quy trình phê duyệt hai người.
8. Đo hiệu năng trên thiết bị thật, so với ngân sách.

## Todo

- [ ] Capacitor 8 + SPM + startApp
- [ ] Driver SQLite native + kiểm tra FTS5
- [ ] Push APNs/FCM + điều hướng
- [ ] NSE iOS + messaging service Android
- [ ] Lifecycle/keyboard/safe area
- [ ] Brand config + CI ký số
- [ ] OTA self-host có chữ ký + phê duyệt hai người
- [ ] Đo hiệu năng thiết bị thật

## Success Criteria

- Trên 2 iPhone và 2 Android thật: nhận thông báo khi app bị kill, mở thông báo vào đúng chat, tin đã bắt kịp trong < 1 s sau khi mở.
- Search local hoạt động (FTS5 có trong build SQLCipher) trên cả hai nền tảng.
- Mở chat từ cache ≤ 100 ms p99 và nhận lô 1.000 update không làm cuộn rớt dưới 55 fps trên thiết bị tham chiếu.
- Bundle OTA giả mạo bị từ chối; link `file:`/`javascript:` không mở được.
- Build TestFlight và Play internal testing tự động từ CI.

## Verification

- `pnpm --filter @app/mobile build && npx cap sync`
- Checklist thiết bị thật lưu kết quả vào `plans/dattqh/reports/` khi chạy phase.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Hiệu năng WebView Android tầm thấp | Cao | Đo sớm; giảm hiệu ứng; ngân sách bundle |
| Không có tiền lệ chat production trên Capacitor | Trung bình | Spike thiết bị thật ngay đầu phase |
| Giới hạn thời gian của iOS NSE | Trung bình | Xử lý tối giản trong extension; kiểm chứng trên thiết bị |

## Security Considerations

- Token phiên lưu Keychain/Keystore, không lưu trong WebView storage.
- DB local mã hoá SQLCipher (ADR 0009), khoá trong Keychain/Keystore.
- Bundle OTA không có chữ ký hợp lệ bị từ chối (test tự động).

## Rollback

App mobile phát hành theo kênh test trước; OTA cho phép quay về bundle trước đó.

## Next Steps

Phase 14 đưa thiết bị thật vào canary đo end-to-end.
