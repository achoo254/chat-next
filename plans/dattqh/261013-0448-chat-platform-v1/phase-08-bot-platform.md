---
phase: 8
title: "Phase 8 (8a): Bot API core — API riêng, kiến trúc học từ Telegram"
status: pending
priority: P1
effort: "XL"
dependencies: [2, 3, 4, 6]
principles: [6, 2, 3, 5]
---

# Phase 8 (8a): Bot API core — API riêng, kiến trúc học từ Telegram

<!-- Updated: Red Team 2026-10-13 - tách 8a/8b (SDK + Console sang Phase 15), consent invariant, update_id một writer, dedupe action trong body, dead-letter, Mini App cô lập origin + khoá KMS, safehttp, một path bulk, tầng verified -->
<!-- Updated: Validation Session 2 2026-10-14 - Bot API theo host tenant, bot thuộc tenant, Mini App trên domain riêng không same-site -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - bridge Mini App: enum sự kiện v1, trần kích thước, schema, chặn điều hướng ngoài origin -->
<!-- Updated: Validation Session 8 2026-10-14 - Mini App chuyển sang Phase 16, file của Bot API làm cùng Phase 4 (cả hai làm sau cùng) -->
<!-- Updated: Validation Session 9 2026-10-14 - lên prod ở release R5; file Bot API trả về phase này vì media đã có từ R3 -->

## Goal

Cung cấp Bot API của riêng sản phẩm, mạnh ngang bot Telegram về khả năng (lệnh, bàn phím, callback, inline, Mini Apps, file, quản trị group), giao update cực nhanh, cô lập lỗi giữa các bot và không thể bị dùng làm công cụ spam. SDK và Developer Console nằm ở Phase 15 (8b).

## Context Links

- [Nền tảng Bot](../reports/researcher-261013-1120-telegram-bot-platform.md) — chỉ phần feature inventory, update delivery, bảo mật; sản phẩm **không** tương thích Telegram
- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — dispatcher, circuit breaker, connection pool, luật opt-in
- ADR 0001, 0003, 0004

## Key Insights

- Bot là user `is_bot` trong core; quyền, privacy mode, rate limit, consent đều cưỡng chế ở core. Bot API gateway chỉ dịch HTTP/JSON ↔ RPC.
- **Consent invariant**: bot chỉ gửi được tới người dùng đã bắt đầu chat với bot (`StartBot`, deep link, bấm nút) hoặc tới chat mà bot là thành viên. Kiểm trong fast path Phase 2, không ở gateway.
- `update_id` cấp bởi consumer outbox shard theo `bot_id` (một writer mỗi bot), không có lock contention.
- Action trả trong body response webhook mang `random_id` dẫn xuất từ `(bot_id, update_id)`, nên retry không gửi trùng.
- Ngữ nghĩa giao update đã kiểm chứng ở Telegram: tuần tự theo chat, song song giữa chat tới `max_connections`; retry 1 s nhân đôi, trần ngẫu nhiên 60–120 s, tôn trọng `Retry-After`; giữ 24 h; long poll tối đa 50 s, hai long poll đồng thời → 409. Thêm: tối đa 10 lần thử mỗi update rồi chuyển dead-letter để không chặn cả chat.

## Requirements

Functional — API v1 (`https://bot.chat.<d>/bot/v1/...`, `Authorization: Bearer <token>`, JSON, error envelope thống nhất), đặc tả trong `spec/bot-api/openapi.yaml`:
- Bot thuộc một tenant (ADR 0010): username bot unique trong tenant, token chỉ dùng được ở host Bot API của tenant đó, bot chỉ thấy và nhắn được user/chat cùng tenant. Bot không có tài khoản ở IdP; chủ bot là user chat.
- Quản lý bot (backend cho Developer Console Phase 15): tạo, đổi tên/mô tả/ảnh, lệnh, privacy mode, cấp lại token, xoá; RPC trong `bots.proto`. Proto v1 chưa có các RPC này, cùng `SendInlineResult` và menu lệnh bot; thêm ở phase này (thêm mới không phá contract).
- Tin nhắn: gửi text (entities hoặc Markdown/HTML subset theo `spec/bot-api/format.md`), sửa, xoá, chuyển tiếp, sao chép, ảnh/file/video/audio/voice/album, "đang gõ", reaction, ghim.
- Bàn phím: reply keyboard, inline keyboard + callback, URL button (scheme theo ADR 0004); trả lời callback. Nút mở Mini App làm ở Phase 16.
- Lệnh theo phạm vi, menu lệnh; deep link `https://chat.<d>/b/<username>?start=<param>` (client hỏi xác nhận trước khi gửi start).
- Inline mode. Mini Apps làm ở [Phase 16](./phase-16-mini-app.md) (release R6, ngay sau release bot).
- Quản trị group: thông tin chat/thành viên/admin, cấm, bỏ cấm, giới hạn quyền (bitmask Phase 2), rời chat.
- File: upload multipart hoặc `file_id` (ACL Phase 4); tải qua URL token ngắn hạn.
- Update: `message`, `message_edited`, `channel_post`, `callback`, `inline_query`, `inline_result_chosen`, `member_changed`, `reaction`.
- Nhận update: long poll và webhook (`url`, `secret`, `allowed_updates`, `max_connections`, `drop_pending`), trạng thái webhook, dead-letter xem được.
- **Gửi hàng loạt: duy nhất `POST /bot/v1/messages:bulk`**, chỉ tới người nhận có consent; bot thường bị giới hạn số người nhận/ngày, bot `verified` cao hơn. Phase 9 dùng chung endpoint này.
- Tầng rate limit: `default`, `verified` (cờ `bots.verified` chỉ đội vận hành hoandat cấp hoặc thu hồi, cho bot của mọi tenant, qua công cụ kiểm duyệt Phase 12; chủ tenant không cấp được), `internal`; dùng `ratelimit` của Phase 2.
- Bot bị kick khỏi chat → huỷ update đang chờ của chat đó.

Ngoài phạm vi v1: payments, games, business, stories.

Non-functional:
- Giao update tới webhook p50 ≤ 100 ms sau commit (dispatch từ `afterCommit`).
- Bot cố ý chậm 10 s không làm tăng độ trễ của bot khác.

## Architecture

```
bot ──HTTPS──> botapi gateway (role=botapi) ──RPC──> core (consent, quyền, rate limit)
outbox (cursor bot, shard theo bot_id) ──> cấp update_id ──> bot_updates
   ├──> webhook dispatcher (per bot: concurrency, circuit breaker, safehttp, HMAC header)
   └──> long poll
```

- Bảng: `bots` (bot user id, owner, token_hash, miniapp_key_enc, privacy, verified, webhook config, tier), `bot_user_consent` (bot_id, user_id, source, created_at), `bot_updates` (bot_id, update_id, chat_id, payload, attempts, expires_at, state).
- `server/internal/safehttp`: mọi outbound fetch (webhook bot, tải file từ URL, Phase 9) đi qua đây — kiểm IP tại thời điểm dial (chặn private, loopback, link-local, metadata, IPv4-mapped IPv6), tắt redirect, chỉ port 80/443/8443, giới hạn kích thước và timeout, không tái dùng kết nối sau khi DNS đổi.

## Related Code Files

Create:
- `spec/bot-api/{openapi.yaml,format.md}`
- `server/internal/botapi/` (router, auth, envelope, mapping, bulk)
- `server/internal/botapi/format/` (parser Markdown/HTML subset → entities, viết mới)
- `server/internal/botupdates/` (cấp update_id, long poll, dispatcher, retry, dead-letter)
- `server/internal/botadmin/` (RPC quản lý bot)
- `server/internal/consent/`
- `server/internal/safehttp/`
- `packages/ui/src/components/bot/` (inline mode)
- `conformance/contract/` (test HTTP thô theo OpenAPI, không phụ thuộc SDK)

## Implementation Steps

1. Viết `openapi.yaml` v1 + `format.md`; review trước khi code.
2. Router + auth token (hash, constant-time) + envelope + rate limit tầng.
3. Consent: ghi khi `StartBot`/deep link/bấm nút/bot là thành viên chung chat; kiểm trong fast path.
4. Mapping core ↔ JSON; test validate response bằng OpenAPI.
5. Parser định dạng + allowlist scheme + fuzz.
6. Consumer outbox theo bot: cấp `update_id`, ghi `bot_updates`.
7. Long poll + 409; dispatcher theo thứ tự trong chat, retry/backoff, `Retry-After`, tối đa 10 lần rồi dead-letter, action trong body với `random_id` dẫn xuất.
8. `safehttp` + test rebinding, redirect, IPv4-mapped, port lạ.
9. Bulk: chỉ người nhận có consent, giới hạn theo tầng, đi làn `bulk` của Phase 3.
10. Inline mode.
11. Contract test HTTP thô cho toàn bộ method.

## Todo

- [ ] OpenAPI + format spec
- [ ] Router + auth + envelope + rate limit tầng
- [ ] Consent invariant
- [ ] Mapping + validate OpenAPI
- [ ] Parser + allowlist scheme + fuzz
- [ ] update_id một writer + bot_updates
- [ ] Long poll + dispatcher + dead-letter + dedupe action
- [ ] safehttp
- [ ] Bulk có consent
- [ ] Inline mode
- [ ] Contract test

## Success Criteria

- Bot gửi cho người dùng chưa bắt đầu chat với bot → 403 (test tự động); bulk bỏ qua người không consent.
- 100% response/update khớp OpenAPI.
- Bot webhook chậm 10 s không làm tăng độ trễ bot khác; dispatcher bị kill giữa lúc xử lý action trong body → action không bị gửi hai lần.
- Update lỗi 10 lần chuyển dead-letter, các update sau của cùng chat vẫn được giao.
- Webhook trỏ tới IP nội bộ (trực tiếp, qua redirect, qua DNS rebinding) → bị chặn.

## Verification

- `cd server && go test ./internal/botapi/... ./internal/botupdates/... ./internal/consent/... ./internal/safehttp/... -race`
- `npx @redocly/cli lint spec/bot-api/openapi.yaml`
- `pnpm conformance:contract`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Đổi API sau khi có bot thật | Trung bình | Version trong URL, chỉ thêm trường trong v1 |
| Bot spam dù có consent | Trung bình | Luật chống abuse cho bot ở Phase 12 (tỷ lệ chặn/báo cáo) |

## Security Considerations

- Token chỉ lưu hash.
- Bảo mật Mini App (origin riêng, khoá ký theo token, bridge, chặn điều hướng) nằm ở [Phase 16](./phase-16-mini-app.md).
- Webhook tới bot kèm header HMAC + timestamp để chống giả mạo và replay.
- Bot không vào được chat `secret`; privacy mode mặc định bật trong group.

## Rollback

Role riêng; tắt role chỉ dừng bot. Dữ liệu bot ở bảng riêng.

## Next Steps

Phase 15 làm SDK + Developer Console trên API này; Phase 9 dùng bulk và lanes; Phase 12 thêm luật abuse cho bot.
