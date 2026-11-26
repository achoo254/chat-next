---
title: "Phase 2: Trang bot như Telegram"
status: completed
---

# Phase 2: Trang bot như Telegram (cỡ M)

## Overview

Lấy hồ sơ bot từ Telegram (mô tả, giới thiệu, danh sách lệnh, nút menu) bằng tài khoản người dùng đang kết nối, cất cache, và để UI bot sẵn có của app (`bots/bot-chat.tsx`, `info-panel.tsx`) hiển thị chúng cho bot Telegram như hiển thị cho bot app.

## Requirements

- [ ] Chat trống với bot Telegram hiện hồ sơ bot (tên, @username, mô tả) và nút «Bắt đầu» gửi `/start` sang Telegram.
- [ ] Chat có tin: ô soạn tin có menu lệnh đúng lệnh bên Telegram; chọn lệnh gửi `/lệnh` sang Telegram.
- [ ] Panel thông tin bot hiện mô tả, giới thiệu và danh sách lệnh.
- [ ] Chat trống hiện ảnh mô tả của bot nếu Telegram có (cất như tệp media của app, không hotlink Telegram).
- [ ] Bot có nút menu mở web app thì ô soạn tin có nút «Mở trong Telegram» tới `https://t.me/<username>`; không chạy Mini App trong app.
- [ ] Hồ sơ lấy từ cache, làm mới nền (khi gặp lần đầu và quá 24 giờ), không gọi Telegram mỗi lần mở chat.
- [ ] Chỉ chủ tài khoản cầu nối xem được hồ sơ bot của mình; bot app không đổi hành vi.

## Files

Đã xác minh tồn tại:
- Modify: `server/internal/bridge/adapter.go` (thêm interface tuỳ chọn `BotInfoReader`, cùng mẫu với `GroupInfos` ở `bridge/info.go`)
- Modify: `server/internal/bridge/adapters/telegram/` (cài `BotInfoReader` bằng `users.getFullUser`; mẫu: `info.go`, `user_photo.go`)
- Modify: `server/internal/bridge/engine/` (làm mới và lưu cache: `people.go`/`info.go` là chỗ gần nhất; chọn khi cài)
- Modify: `server/internal/rpc/bots_service.go` (`GetBotInfo`: nhánh bot Telegram)
- Modify: `apps/web/src/messaging/bots/bot-chat.tsx` (`BotStartBar`: gửi `/start` bằng đường gửi thường khi `chat.externalApp` có giá trị), `apps/web/src/messaging/ui/info-panel.tsx` (khối bot), copy 3 ngôn ngữ

Tạo mới:
- Create: `server/migrations/0068_external_users_bot_info.sql` (`bot_info jsonb`, `bot_info_at timestamptz`, đều nullable)
- Create: test tương ứng cho adapter, engine, RPC

Chưa xác minh: trường chính xác của `tg.BotInfo` trong phiên bản gotd đang vendor (mô tả, lệnh, nút menu, ảnh mô tả); đường gửi thường của chat đồng bộ dùng từ web (`bots.start` hiện đi `StartBot`). Dò hai điểm này trước khi viết.

## Implementation Steps

1. **Dò gotd**: đọc `tg.UsersGetFullUser` và `tg.BotInfo` trong module đã vendor; chốt trường cần lấy (mô tả, lệnh, nút menu). Ghi cấu trúc cache ở `docs` nếu có đổi.
2. **Adapter**: `BotInfo(ctx, acct, userID) (bridge.BotInfo, error)` với `bridge.BotInfo{Description, About, Commands []BotCommand, MenuKind}`; đi qua cùng cơ chế hạn mức và `RateLimitError` như các lời gọi khác.
3. **Engine**: khi puppet có `is_bot` mà chưa có cache hoặc cũ hơn 24 giờ, gọi `BotInfo` (nền, không chặn nhập tin) và lưu `bot_info`, `bot_info_at`; lỗi thì ghi nhận và thử lại lần sau, không làm kẹt vòng nhập.
4. **RPC**: `GetBotInfo` nếu `bot_id` không phải bot app: tra `external_users` theo `user_id`, kiểm tài khoản cầu nối thuộc `me`, dựng `GetBotInfoResponse` (user, description, about, commands, `is_owner = false`, `not_running = false`); không thuộc `me` hoặc không phải bot → `not_found` như hiện nay.
5. **Web**: `BotStartBar` theo `chat.externalApp`; panel thông tin bot đọc cùng dữ liệu `BotInfo` sẵn có; menu lệnh không đổi. Chữ mới 3 ngôn ngữ.
6. **Tài liệu**: `docs/integrations/chat-bridge.md` (bot Telegram trong app: nhận gì, không nhận gì), `docs/acceptance.md` (dòng bài thử thật).

## Verification

- Go: adapter với Telegram giả trả `BotInfo`; engine lưu cache, bỏ qua khi còn mới, làm mới khi quá hạn; lỗi lấy hồ sơ không chặn nhập tin.
- Go: `GetBotInfo` cho bot Telegram của chính mình trả đúng; của người khác và bot không tồn tại trả `not_found`; bot app không đổi.
- Web (vitest): chat trống bot Telegram hiện hồ sơ và «Bắt đầu» gửi `/start` bằng đường chat thường (không gọi `StartBot`); menu lệnh hiện đúng danh sách; đủ ba ngôn ngữ.
- Lệnh: `go test ./internal/bridge/... ./internal/rpc/...` (từng gói); `pnpm --filter <gói web> typecheck lint test`.
- Thật: bot thử trên production: hồ sơ khớp BotFather, chọn một lệnh thì bot trả lời bên Telegram, chat trống (chat thử mới) có «Bắt đầu». Ghi vào `docs/acceptance.md`.

## Risks

- `getFullUser` bị Telegram giới hạn (FloodWait) khi có nhiều bot lần đầu: gom và nối tiếp, mỗi lượt vài bot, dùng `RateLimitError` sẵn có.
- Lệnh bot đổi ở BotFather thì app trễ tới 24 giờ: chấp nhận, ghi trong tài liệu.
- Mini App không chạy ngoài Telegram: chỉ có nút mở bot trong Telegram (đã chốt).
- Ảnh mô tả là media: tải một lần qua `FetchMedia` rồi cất như tệp của app; ảnh lớn hoặc tải lỗi thì bỏ qua êm, hồ sơ vẫn hiện bằng chữ. Chọn cách lưu (kho media hiện có) khi cài, ghi vào báo cáo.

## Rollback

Migration expand-only; tắt tính năng bằng cách bỏ nhánh bot Telegram ở `GetBotInfo` (UI quay về chat thường với bot, như phase 1).

## Todo

- [ ] Dò `tg.BotInfo` và đường gửi thường từ web
- [ ] Adapter `BotInfoReader`
- [ ] Engine làm mới và cache
- [ ] `GetBotInfo` cho bot Telegram
- [ ] Web: Bắt đầu, panel, copy 3 ngôn ngữ
- [ ] Test, bài thử thật, tài liệu

## Success Criteria

Trang bot Telegram trong app có mô tả, lệnh và «Bắt đầu» như bên Telegram; chọn lệnh gửi được sang Telegram; bot app không đổi hành vi.
