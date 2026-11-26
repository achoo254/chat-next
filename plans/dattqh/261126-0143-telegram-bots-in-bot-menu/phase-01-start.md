---
title: "Phase 1: Nhận diện bot, hiện ở mục Bot kèm logo"
status: completed
---

# Phase 1: Nhận diện bot, hiện ở mục Bot kèm logo (cỡ S–M)

## Overview

Ghi lại việc người kia là bot khi engine gặp họ, đưa cờ đó ra client qua `User.is_bot`, để chat bot Telegram tự rơi vào mục Bot (`chatKind` → `bot`) và hiện logo Telegram. Không cần token, không đụng engine ngoài việc ghi thêm một cột.

## Requirements

- [ ] `external_users.is_bot` đúng cho puppet mới và cho puppet cũ sau lần gặp lại kế tiếp.
- [ ] Client nhận `is_bot = true` cho puppet bot; `users.is_bot` (cột) vẫn `false` cho puppet.
- [ ] Mục Bot liệt kê chat bot Telegram, hàng có logo Telegram và nhãn Bot; trạng thái trực tuyến không hiện; bot không lọt vào danh bạ.
- [ ] Bot app và người thường không đổi hành vi.

## Files

Đã xác minh tồn tại:
- Modify: `server/internal/bridge/engine/store.go` (`ensurePuppet`, `createPuppet`: ghi/cập nhật `is_bot` từ `Participant.IsBot`; giữ comment «không đặt `users.is_bot`», bổ sung lý do cột riêng)
- Modify: `server/internal/chat/render.go` (nạp `external_users.is_bot` cùng người dùng; `IsBot = u.IsBot || u.ExternalBot` ở dòng dựng `appv1.User`, gồm cả nhánh `Deleted` không cần)
- Xem lại, không đổi nếu an toàn: `server/internal/botapi/wire/wire.go:290-299`, `server/internal/assistant/assistant.go:159`, `server/internal/chat/people.go:52`
- Web, chỉ kiểm: `apps/web/src/messaging/data/format.ts` (`chatKind`), `ui/chat-row.tsx` (logo app ở hàng bot), `ui/folder-rail.tsx`

Tạo mới:
- Create: `server/migrations/0067_external_users_is_bot.sql` (số kế tiếp sau `0066`; cột `boolean NOT NULL DEFAULT false`, expand-only, `SET LOCAL lock_timeout`)

Chưa xác minh: cầu nối có đồng bộ lại danh sách chat định kỳ cho tài khoản đang chạy không (quyết định cần dò một lần); nơi test của `render.go`.

## Implementation Steps

1. **Migration** thêm cột. Sao lưu DB trước khi chạy trên production.
2. **Engine**: `createPuppet` ghi `is_bot = p.IsBot`; nhánh người đã có trong `ensurePuppet` cập nhật khi giá trị đổi (cùng mẫu với đổi tên/ảnh, một câu lệnh `UPDATE` có điều kiện).
3. **Render**: nạp cờ qua cùng truy vấn người dùng; đặt `appv1.User.IsBot` như thiết kế 2 của plan. Chặn hồi quy: test đi qua `wire.FromUser` và `assistant` với puppet bot.
4. **Dò dữ liệu cũ**: xem `account_sync.go` có chạy lại `ListConversations` khi tài khoản kết nối lại. Nếu có, không làm gì thêm; nếu không, thêm một lượt đồng bộ danh sách khi engine khởi động để điền cờ cho puppet cũ.
5. **Web**: chạy thử màn hình thật; nếu hàng bot không hiện logo hoặc nhãn trùng với nhãn Bot, sửa ở `chat-row.tsx` và copy (3 ngôn ngữ).
6. **Tài liệu**: một dòng ở `docs/integrations/chat-bridge.md` (bot Telegram nằm ở mục Bot).

## Verification

- Go: `ensurePuppet` với `Participant{IsBot: true}` tạo puppet có `external_users.is_bot = true` và `users.is_bot = false`; gặp lại với `IsBot` đổi thì cập nhật.
- Go: render trả `IsBot = true` cho puppet bot, `false` cho người thường; Bot API wire không đổi kết quả với bot app.
- Web (vitest, mẫu `apps/web/test/bots.test.tsx` và `people.test.tsx`): chat với peer `isBot` rơi vào folder `bot`, có logo Telegram.
- Lệnh: `go vet ./internal/bridge/... ./internal/chat/...`, `go test` cùng gói; `pnpm --filter <gói web> typecheck lint test`.
- Thật: sau khi lên production, chat bot thử (đã đồng bộ) nằm ở mục Bot; chat người thường không đổi; chụp màn hình ghi vào báo cáo.

## Risks

- `is_bot` ở proto bật nhầm đường dành cho bot app (consent, `StartBot`, mini-app) trên chat bot Telegram: phase 2 xử lý «Bắt đầu» và `GetBotInfo`; trước khi phase 2 xong, hai đường này phải lỗi êm (không báo lỗi to). Nếu không êm được, gộp hai phase khi cài.
- Puppet cũ chưa đổi cờ cho tới lần gặp lại: chấp nhận, đã có bước 4.

## Rollback

Migration expand-only; quay lại bằng cách bỏ dòng `IsBot` ở render (mục Bot quay về như cũ ngay), cột để nguyên.

## Todo

- [ ] Migration và sao lưu
- [ ] Engine ghi cờ
- [ ] Render đưa cờ ra client, test chặn hồi quy
- [ ] Dữ liệu cũ
- [ ] Kiểm logo và nhãn ở web (3 ngôn ngữ)

## Success Criteria

Bot Telegram đã đồng bộ hiện ở mục Bot kèm logo Telegram; bot app, người thường và danh bạ không đổi.
