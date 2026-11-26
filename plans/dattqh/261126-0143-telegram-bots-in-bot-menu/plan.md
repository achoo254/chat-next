---
title: "Bot Telegram hiện ở mục Bot, tính năng như Telegram"
description: "Các bot Telegram đã đồng bộ qua tài khoản người dùng được nhận diện là bot, hiện ở mục Bot kèm logo Telegram, và trang bot hiển thị mô tả, lệnh như Telegram."
status: pending
priority: P1
effort: "M (hai phase)"
tags: [chat-bridge, bots, telegram]
created: 2026-11-26
---

# Bot Telegram hiện ở mục Bot, tính năng như Telegram

## Overview

Mục **Bot** ở thanh trái là bộ lọc danh sách chat theo loại `bot` (`folder-rail.tsx`, `chatKind` ở `data/format.ts`: `peer.isBot`). Bot Telegram đã đồng bộ chưa lọt vào đó vì người dùng ảo (puppet) của cầu nối luôn có `isBot = false`, dù adapter Telegram đã biết đó là bot (`Participant.IsBot`, `ConvBot`) và engine bỏ thông tin đi (`engine/store.go:371`).

Kế hoạch này làm hai việc, đúng như đại ca chốt 26/11/2026:
1. Bot Telegram hiện trong mục Bot, kèm logo Telegram để nhận diện.
2. Trang bot Telegram trong app hiển thị các tính năng như Telegram hiển thị: mô tả, giới thiệu, menu lệnh, nút «Bắt đầu» ở chat trống.

## Outcome đã chốt

- **Hai luồng bot giữ nguyên, chạy song song**: bot của app (bảng `bots`, Bot API, console) và bot Telegram (chat đồng bộ qua tài khoản người dùng). Không nối chúng với nhau.
- **Đã bỏ hẳn** các yêu cầu trước: token BotFather, bot Telegram làm lõi của bot app, cờ «Đồng bộ Telegram bot», luồng `getUpdates`, hướng A/B, mọi thay đổi ADR. Plan cũ (`261126-0133-telegram-bot-core`) đã xoá.
- Không cần token: lấy thông tin bot bằng chính tài khoản Telegram của người dùng đã liên kết (MTProto).

## Constraints

- Repo công khai: không ghi IP, secret, token, số điện thoại vào code, test hay log.
- Chỉ dùng `pnpm`; gate: `pnpm lint` → `pnpm typecheck` → `pnpm test` cho gói web liên quan, `go vet` + `go test` cho gói server liên quan, chạy từng gói (máy dev dùng chung).
- Ba ngôn ngữ giao diện (vi, en, zh-CN) cho mọi chữ mới.
- Sao lưu DB trước migration trên production.
- `users.is_bot` (cột) vẫn nghĩa «bot của hệ thống này» (consent, Bot API); không đặt cột này cho puppet (comment `engine/store.go:371` giữ nguyên).

## Non-goals

- Nối bot Telegram với bot app, nhận tin qua token bot, mục BOT quản lý (console) cho bot Telegram.
- Nhóm có bot Telegram (menu lệnh theo nhóm); bấm nút callback của bot (cầu nối vốn không có đối ứng, `adapter.go:193`); chạy Mini App của Telegram trong app (cần dữ liệu khởi tạo của Telegram); chỉ có nút mở bot trong Telegram.
- Gộp hay đổi các chat bot cũ ngoài việc đánh dấu là bot.

## Quyết định thiết kế

1. **Cờ bot nằm ở `external_users.is_bot`**, cột mới riêng của puppet, ghi bởi `ensurePuppet` mỗi lần gặp lại người đó. Dữ liệu cũ tự đúng sau lần đồng bộ danh sách chat kế tiếp (adapter báo `Peer.IsBot` mỗi lần); nếu cầu nối không đồng bộ lại định kỳ thì thêm một lượt dò một lần (kiểm ở phase 1).
2. **Chỉ lộ ra ở lớp trình bày**: khi dựng `User` cho client (`chat/render.go`), `is_bot` proto = `users.is_bot OR external_users.is_bot`. Web không đổi cách tính `chatKind`; mọi nơi đang dựa `peer.isBot` (nhãn Bot, ẩn trạng thái trực tuyến, loại khỏi danh bạ `contacts-model.ts:64`) tự đúng. Rủi ro cần kiểm: người tiêu dùng khác của `appv1.User.is_bot` phía server, đã thấy `botapi/wire/wire.go:290-299` (chỉ bỏ ngôn ngữ cho bot) và `assistant.go:159`; thêm test chặn hồi quy. Nếu phát hiện đường nhạy cảm thì đổi sang trường proto riêng `external_bot` và một hàm `isBotUser` ở web.
3. **Thông tin bot lấy từ Telegram** bằng `users.getFullUser` của tài khoản đang kết nối (`BotInfo`: mô tả, lệnh, nút menu), cất cache ở `external_users.bot_info` (jsonb) kèm thời điểm; engine làm mới khi gặp bot lần đầu và khi cache quá 24 giờ. RPC chỉ đọc cache, không gọi Telegram theo từng lượt mở chat.
4. **`GetBotInfo` phục vụ cả bot Telegram**: nếu `bot_id` không phải bot app mà là puppet bot thuộc tài khoản cầu nối của chính người gọi thì trả hồ sơ từ cache; người khác gọi bị từ chối như không tồn tại. Menu lệnh của UI hiện có (`bot-chat.tsx`) dùng lại nguyên.
5. **«Bắt đầu» ở chat trống**: bot app dùng `StartBot` (có consent); bot Telegram gửi tin `/start` bằng đường gửi thường của chat đồng bộ (đã hai chiều). Chọn đường theo `chat.externalApp`.
6. **Logo Telegram**: chat đồng bộ đã có logo app ở hàng chat (`chat-row.tsx:238-262`); kiểm hàng thuộc loại bot cũng hiện, và thêm logo ở đầu trang bot nếu thiếu.

## Extension trace

Nền tảng kế tiếp có bot (Zalo OA, Discord): hợp đồng ổn định là `bridge.Participant.IsBot` và `external_users.is_bot`; phần phải thêm là một `BotInfoReader` tuỳ chọn trong adapter mới. Không thêm registry hay cấu hình chung; chỉ một adapter thật (Telegram).

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Nhận diện bot, hiện ở mục Bot kèm logo](./phase-01-start.md) | Pending |
| 2 | [Trang bot như Telegram: mô tả, lệnh, Bắt đầu](./phase-02-telegram-bot-profile-like-telegram.md) | Pending |

Phase 1 độc lập và có giá trị riêng (bot hiện ở mục Bot). Phase 2 phụ thuộc phase 1 (cần cờ bot). Cỡ: phase 1 là S–M, phase 2 là M.

## Success Criteria

- [ ] Bot Telegram đã đồng bộ (ví dụ chat với bot thử) hiện ở mục Bot, có logo Telegram, nhãn Bot, không hiện trạng thái trực tuyến, không lọt vào danh bạ.
- [ ] Mở chat bot Telegram: thấy tên, @username, mô tả, giới thiệu, menu lệnh giống BotFather đặt bên Telegram; chọn lệnh thì gửi `/lệnh` sang Telegram; chat trống có nút «Bắt đầu» gửi `/start`.
- [ ] Bot của app (console, Bot API, consent) không đổi hành vi; test hiện có của `botadmin`, `botapi`, `chat`, `bridge/engine` vẫn đạt.
- [ ] Gate đạt cho từng gói động tới; bài thử thật trên production với bot thử, ghi vào `docs/acceptance.md`.

## Đã chốt thêm (26/11/2026)

- Bot Telegram có nút menu kiểu «mở web app»: app hiện **nút mở liên kết của bot trong Telegram** (`https://t.me/<username>`), không chạy Mini App trong app.
- **Lấy ảnh mô tả** (`description_photo`) của bot nếu có và hiện trong chat trống như Telegram.

## Câu hỏi chưa chốt

Không còn.

<!-- slug: telegram-bots-in-bot-menu -->
