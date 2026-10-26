# ADR 0008: Branding và quy ước đặt tên

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14
- Cập nhật 20/10/2026: mã thương hiệu chuyển sang gói dùng chung `@shared-next/brand` (repo [`shared-next`](https://github.com/achoo254/shared-next), cài theo tag git). Schema `brand.config.schema.json` của repo này bị xóa; `brand.config.json` trỏ `$schema` về schema trong gói. `pnpm brand:gen` gọi API `./build` của gói (`apps/web/scripts/brand-gen.ts`, tùy chọn của chat ở `apps/web/brand-files.ts`), file sinh chuyển sang `brand/generated/` (cạnh logo); lint tên cứng là CLI `check-brand` của gói (`pnpm check:brand`). Gói `packages/brand` cũ đã gỡ.
- Huỷ 20/10/2026: desktop = PWA. Toàn hệ sinh thái không có app desktop native (Tauri); trên máy tính dùng bản web cài dạng PWA, đăng nhập bằng `chat-web`. Client `chat-desktop` đã gỡ khỏi IdP. Phần nói về desktop/Tauri bên dưới chỉ còn là lịch sử.
- Đơn tenant 24/10/2026 ([ADR 0013 của `auth-next`](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md), thay [ADR 0010](./0010-tenants-by-domain.md)): chỉ còn tenant `hoandat.com`; tên tenant là `TENANT_DOMAIN` của server (`tenant_name` của `GetAuthConfig`), không lấy `displayName` từ IdP. Phần nói về nhiều tenant bên dưới chỉ còn là lịch sử.

## Bối cảnh

Tên sản phẩm chưa cố định và có thể đổi. Tên, màu, icon, bundle id, scheme và domain xuất hiện ở web manifest, cấu hình Capacitor, cấu hình Tauri, push, Bot API và tài liệu. Nếu chúng nằm rải rác trong code thì đổi tên là một đợt sửa tay dễ sót. Sản phẩm học kiến trúc và hiệu năng từ Telegram nhưng độc lập với Telegram: không tương thích và không liên quan về API, tên gọi hay thương hiệu. App còn phục vụ nhiều tenant theo domain, mỗi tenant có tên hiển thị riêng.

## Quyết định

- `brand.config.json` ở gốc repo, có `brand.config.schema.json` đi kèm, là nguồn duy nhất cho: tên app, tên ngắn, màu, icon, bundle id iOS/Android/Tauri, URL scheme, domain gốc của tenant chính (`hoandat.com`), mẫu host theo tenant, domain media dùng chung, issuer IdP của tenant chính và tên người gửi push. Không có tên người gửi email vì app không gửi email.
- Generator sinh web manifest, cấu hình Capacitor và cấu hình Tauri từ `brand.config.json`. Đổi tên sản phẩm chỉ cần sửa file này và build lại.
- Trong tài liệu, các placeholder `{{APP_NAME}}`, `{{scheme}}`, `{{media_domain}}` và `{{miniapp_domain}}` chỉ tới giá trị tương ứng trong `brand.config.json`.
- Scheme của bản build hiện tại là `com.hoandat.chat`. IdP đọc redirect mobile từ biến môi trường `CHAT_MOBILE_REDIRECT_URI` (mặc định `com.hoandat.chat:/auth/callback`), giống nhau ở mọi tenant, xem [ADR 0006](./0006-sign-in-and-chat-sessions.md).
- Tên hiển thị của tenant lấy từ IdP (`displayName` qua API nội bộ, xem [ADR 0010](./0010-tenants-by-domain.md)), không lấy từ `brand.config.json`. UI hiện tên tenant ở màn hình chào và cài đặt khi không phải tenant chính.
- Bot token là chuỗi opaque có tiền tố theo brand.
- Quy ước tên trong code:
  - App trong `apps/` đặt tên `@app/<tên thư mục>`; gói trong `packages/` và `sdk/ts` mang scope `@achoo254/chat-*` (chỉ `@achoo254/chat-client` và `@achoo254/chat-bot-sdk` phát hành npm, xem `package.json` của từng gói); package gốc của workspace mang tên repo (`chat-next`).
  - Server là một Go module với một binary `server/cmd/server`, chạy theo role.
  - Protobuf nằm ở `proto/app/v1`, mỗi domain một file.
- Không có tên sản phẩm viết cứng trong code; một lint rule chặn điều này. Chuỗi `chat-inet` (tên repo cũ, trước khi hệ sinh thái đổi sang tên `*-next`) vẫn bị chặn: không xuất hiện trong code sản phẩm, UI hay identifier.

## Lý do

- Một nguồn cấu hình cộng generator là cách duy nhất bảo đảm đổi tên không sót chỗ nào, và kiểm được bằng CI.
- Tên người gửi email bị bỏ vì đăng nhập và mọi email thuộc IdP; app chat không có SMTP.
- Tenant do chủ domain quản lý ở IdP; lấy `displayName` từ IdP tránh hai nguồn sự thật cho tên tenant.
- `@app/*`, `@achoo254/chat-*` và `proto/app/v1` là tên trung tính, không đổi khi tên sản phẩm đổi.

## Hệ quả

- Mọi chỗ cần tên, màu hay domain phải đọc từ `brand.config.json` (qua `@shared-next/brand` hoặc `apps/web/src/brand.ts`) hoặc file sinh ra, không tự khai hằng.
- CI có bước tìm tên sản phẩm cứng và chuỗi cấm trong `apps`, `packages`, `server`, `proto`.
- Một bản app mobile và desktop phục vụ mọi tenant; tên và màu của app là của sản phẩm, chỉ tên tenant thay đổi theo tenant.

## Cách thay đổi

- Đổi tên, màu, icon: sửa `brand.config.json`, chạy generator, build lại mọi nền tảng.
- Đổi bundle id: cửa hàng ứng dụng coi đó là app khác; cần kế hoạch chuyển người dùng sang bản mới.
- Đổi scheme: đổi `urlScheme` trong `brand.config.json` và `CHAT_MOBILE_REDIRECT_URI` của IdP, đổi allowlist scheme ở [ADR 0004](./0004-text-format.md), rồi phát hành bản app mới; bản cũ không đăng nhập được nữa.
- Đổi domain media hoặc Mini App: xem ràng buộc same-site ở [ADR 0010](./0010-tenants-by-domain.md) trước khi chọn domain mới.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
