---
phase: 15
title: "Phase 15 (8b): SDK bot và Developer Console"
status: pending
priority: P1
effort: "L"
dependencies: [8]
principles: [6, 3]
---

# Phase 15 (8b): SDK bot và Developer Console

<!-- Created: Red Team 2026-10-13 - tách từ Phase 8 theo quyết định user: Console + 3 SDK (TS chỉ Node, Python, Go), bỏ bot hệ thống quản lý bot -->

<!-- Updated: Validation Session 2 2026-10-14 - SDK base URL theo tenant, Console dùng phiên chat + đăng nhập gần đây cho thao tác token -->
<!-- Updated: Validation Session 8 2026-10-14 - Mini App và file chuyển sang Phase 16 và 4 -->
<!-- Updated: Validation Session 9 2026-10-14 - lên prod ở release R5 cùng Bot API; file trả về phase này -->

## Goal

Vì sản phẩm độc lập, không có hệ sinh thái thư viện sẵn. Phase này bù bằng SDK chính thức cho TypeScript (Node), Python, Go và Developer Console trong app để nhà phát triển tạo, cấu hình và theo dõi bot mà không cần đọc mã nguồn server.

## Context Links

- Phase 8 (`spec/bot-api/openapi.yaml`, RPC quản lý bot)
- [Nền tảng Bot](../reports/researcher-261013-1120-telegram-bot-platform.md) — kế hoạch conformance (chỉ phần phương pháp)

## Key Insights

- OpenAPI là nguồn sự thật: model của SDK sinh từ đó; phần runtime (long poll, webhook handler kiểm HMAC, router lệnh/callback, retry tôn trọng `retry_after`) viết tay cho từng ngôn ngữ.
- Developer Console là kênh quản lý bot duy nhất của v1 (theo quyết định user, không có bot hệ thống dạng chat).
- Phase 9 không phụ thuộc phase này; chỉ Phase 14 cần SDK để chạy conformance đầy đủ.

## Requirements

Functional:
- SDK TS (Node LTS), Python (3.11+), Go: base URL cấu hình được theo tenant (mặc định `https://chat.hoandat.com/bot/v1`), client có kiểu, long poll, webhook handler (kiểm HMAC + timestamp), router lệnh/callback/inline, upload file, bulk. Helper xác thực dữ liệu khởi tạo Mini App thêm ở Phase 16.
- Ví dụ chạy được cho mỗi SDK: echo, bàn phím + callback, file, lệnh, inline (ví dụ Mini App thêm ở Phase 16).
- Developer Console (trong `packages/ui`, truy cập từ cài đặt, dùng phiên chat; bot tạo trong tenant của người dùng): xem/cấp lại token và xoá bot cần đăng nhập IdP trong 10 phút gần đây (ADR 0006); tạo bot, đổi tên/mô tả/ảnh, lệnh, privacy mode, xem/cấp lại token (hiển thị một lần), cấu hình webhook, xem trạng thái webhook, dead-letter, bộ đếm gửi, tầng rate limit hiện tại.
- Docs: bắt đầu nhanh, tham chiếu sinh từ OpenAPI, hướng dẫn bảo mật webhook (Mini App thêm ở Phase 16).
- Phát hành SDK lên registry nội bộ trước (npm, PyPI, Go module proxy), registry công khai khi ra mắt.

Non-functional:
- Lập trình viên mới tạo được bot echo trong ≤ 10 phút theo docs (đo trong Phase 14 với người ngoài đội).

## Related Code Files

Create:
- `sdk/ts/`, `sdk/python/`, `sdk/go/` (mỗi nơi có `examples/`)
- `packages/ui/src/components/developer-console/`
- `conformance/sdk/` (bot mẫu × SDK × long poll/webhook với người dùng giả lập)
- `docs/bot-api/`

## Implementation Steps

1. Pipeline sinh model từ OpenAPI cho 3 ngôn ngữ, chạy trong CI khi OpenAPI đổi.
2. Runtime TS, Python, Go + ví dụ.
3. Developer Console UI trên RPC quản lý bot của Phase 8.
4. Conformance: 3 SDK × 2 chế độ × kịch bản (echo, keyboard, callback, file, lệnh, inline); kịch bản Mini App thêm ở Phase 16.
5. Docs + quick start.
6. Phát hành registry nội bộ, version theo semver gắn với version API.

## Todo

- [ ] Sinh model từ OpenAPI (3 ngôn ngữ)
- [ ] Runtime + ví dụ TS/Python/Go
- [ ] Developer Console
- [ ] Conformance 3 SDK × 2 chế độ
- [ ] Docs
- [ ] Phát hành registry nội bộ

## Success Criteria

- Bot mẫu của cả 3 SDK pass toàn bộ conformance ở long poll và webhook.
- Đổi OpenAPI làm hỏng model SDK → CI đỏ.
- Toàn bộ thao tác quản lý bot làm được trên Console, không cần gọi API thủ công.

## Verification

- `pnpm conformance:sdk`
- `cd sdk/python && pytest`; `cd sdk/go && go test ./...`; `pnpm --filter @app/sdk test`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Ba SDK lệch hành vi | Trung bình | Conformance chung, model sinh từ một OpenAPI |
| Chi phí bảo trì SDK | Trung bình | Runtime mỏng, phần lớn sinh tự động |

## Security Considerations

- Token chỉ hiển thị một lần trong Console; khuyến nghị lưu ở secret manager.
- SDK mặc định bật kiểm HMAC webhook (kiểm `auth_date` của Mini App thêm ở Phase 16).

## Rollback

SDK có version; yank bản lỗi. Console là màn hình trong app, ẩn bằng feature flag nếu cần.

## Next Steps

Phase 14 dùng conformance SDK và bài thử "bot echo trong 10 phút".
