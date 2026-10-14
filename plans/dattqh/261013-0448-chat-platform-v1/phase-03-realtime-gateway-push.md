---
phase: 3
title: "Phase 3: Realtime gateway và push"
status: pending
priority: P1
effort: "L"
dependencies: [2]
principles: [2, 4, 7, 5]
---

# Phase 3: Realtime gateway và push

<!-- Updated: Red Team 2026-10-13 - kênh c:{chat_id}, kiểm membership open_chat, session_revoked, push từ afterCommit, push batch chat lớn, badge counter, payload mã hoá, lanes sở hữu ở đây -->
<!-- Updated: Validation Session 2 2026-10-14 - gateway chỉ nhận phiên chat, kiểm tenant theo Host, session_revoked từ back-channel logout IdP -->

## Goal

Đưa update tới thiết bị đang online trong vài chục mili-giây qua WebSocket và tới thiết bị offline qua FCM/APNs/Web Push, kể cả trong group hàng trăm nghìn thành viên, mà không đánh đổi tính đúng đắn của sync hay quyền riêng tư.

## Context Links

- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md) — gateway, subject `c.<chat_id>`, push
- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — eager dispatch, lanes, quota FCM
- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 3
- ADR 0002, 0003, 0006, 0010

## Key Insights

- Hai loại kênh fan-out: `u:{user_id}` cho update per-user (chat `small`, sự kiện cá nhân) và `c:{chat_id}` cho chat `large`, chỉ phát tới session đang mở chat đó hoặc đang hiển thị nó trong danh sách.
- Typing/presence chỉ phát tới session có `open_chat_id` **đã được kiểm tra membership** khi client gửi `OpenChat`.
- Push được dispatch ngay sau commit (hook `afterCommit` của Phase 2); sweeper chỉ là lưới an toàn.
- Push cho chat lớn đi theo làn riêng có quota, gộp theo chat; badge tính bằng counter Redis tăng/giảm theo sự kiện, không SUM trên Postgres.
- iOS không giao push nền cho app bị người dùng tắt và giới hạn tần suất push nền, nên xoá thông báo chéo thiết bị chỉ là best-effort; mỗi push mới mang `read_inbox_max_seq` để NSE dọn thông báo cũ. Android dùng `tag` theo chat để thay thông báo.
- FCM collapsible message bị giới hạn burst 20/thiết bị (nạp 1 lần mỗi 3 phút); FCM có quota khoảng 600k tin/phút mỗi project — phải chia quota giữa các làn.

## Requirements

Functional:
- WebSocket (`role=gateway`), frame Protobuf, xác thực theo ADR 0006 (cookie phiên chat + Origin cho web, token phiên chat cho native; không nhận token của IdP), tenant của phiên phải trùng tenant suy từ Host (ADR 0010), Origin kiểm theo allowlist của tenant, heartbeat, kết nối lại theo thứ tự subscribe → đệm → `GetDifference` → hợp nhất.
- Session registry Redis: `user_id → {session_id, node, foreground, open_chat_id}`; nhận `session_revoked` thì đóng socket của session đó trong ≤ 1 s. `session_revoked` có thể đến từ back-channel logout của IdP hoặc job kiểm grant (Phase 2), không chỉ từ thao tác trong app.
- Khi WS kết nối lại, gateway báo Phase 2 kiểm grant IdP nếu `idp_checked_at` quá 1 giờ; việc kiểm chạy nền, không chặn handshake.
- Typing, presence (tôn trọng `privacy_settings`), trạng thái đã đọc realtime.
- Bốn làn ưu tiên **do phase này sở hữu**: transactional, alert, interactive, bulk; mỗi làn worker và quota push riêng; Phase 8, 9 chỉ tiêu thụ.
- Push dispatcher: token APNs, FCM, Web Push gắn với session; bỏ qua khi user có session foreground; gộp theo chat; badge từ counter Redis; payload mã hoá bằng khoá riêng của từng thiết bị (NSE/Android service giải mã) khi người dùng bật xem trước; nếu tắt xem trước thì chỉ gửi "Bạn có tin nhắn mới".
- Xoá thông báo chéo thiết bị: silent push (Android data message có hiển thị cập nhật, iOS best-effort) + `read_inbox_max_seq` trong mọi push.

Non-functional:
- Tới người nhận online: p50 ≤ 150 ms, p99 ≤ 500 ms (chat `small`); chat `large` 100k thành viên: p99 ≤ 2 s cho session đang mở chat.
- Một gateway node giữ ≥ 100k kết nối.

## Architecture

```
api commit ──afterCommit──> publish u:{id} / c:{chat_id} (Redis v1 → NATS khi scale)
gateway (Go) subscribe u:{id} của mỗi session + c:{chat_id} của chat large đang mở/hiển thị
afterCommit ──> push dispatcher (lanes) ──> APNs HTTP/2 / FCM v1 / Web Push
outbox sweeper ──> nhặt việc bị rơi
```

Backpressure: hàng đợi giới hạn mỗi kết nối; đầy thì gửi `Resync` và đóng, client gọi `GetDifference`.

## Related Code Files

Create:
- `server/internal/gateway/` (ws, session, fan-out, backpressure, revoke)
- `server/internal/presence/`
- `server/internal/push/` (apns, fcm, webpush, dispatcher, lanes, badge, payload crypto)
- `server/migrations/00xx_push_devices.sql` (token + khoá công khai thiết bị)

## Implementation Steps

1. WS server (`github.com/coder/websocket`), auth theo ADR 0006, heartbeat 25 s, đóng idle.
2. Session registry, subscribe `u:{id}`; `OpenChat` kiểm membership rồi subscribe `c:{chat_id}` nếu chat `large`.
3. Thứ tự kết nối lại và gửi `server_epoch` trong `Hello`.
4. `session_revoked` → đóng socket.
5. Typing/presence TTL ngắn, chỉ tới session hợp lệ.
6. Lanes + quota; dispatcher nhận việc từ `afterCommit`; làn riêng cho chat large có batch và giới hạn tần suất.
7. Badge counter Redis (tăng khi tin mới, giảm khi `read`).
8. APNs (token .p8), FCM HTTP v1, Web Push (VAPID); mã hoá payload theo thiết bị.
9. Metrics: số kết nối, độ trễ publish→deliver, tỷ lệ resync, lỗi push theo nhà cung cấp, quota còn lại.

## Todo

- [x] WS + auth + heartbeat + reconnect order + epoch
- [x] Registry + `u:`/`c:` + kiểm membership OpenChat (registry trong bộ nhớ của process `api`; Redis/NATS khi scale ngang)
- [x] session_revoked đóng socket (trigger → outbox → consumer 150 ms; test đo dưới 1 s)
- [x] Typing/presence tôn trọng privacy
- [ ] Lanes + quota + push từ afterCommit + batch chat large (push: R7)
- [ ] Badge counter (R7)
- [ ] APNs/FCM/Web Push + payload mã hoá + xoá thông báo chéo (R7)
- [ ] Metrics (chưa có hạ tầng metrics; Phase 13)

### Kết quả R1 (2026-10-14)

- Gateway chạy trong process `api` ở `wss://chat.hoandat.com/ws` (cùng origin, nginx `location = /ws` có header upgrade), không thêm process hay cổng: giai đoạn 1 chỉ một server, pm2 một instance, nên hub trong bộ nhớ nhận update thẳng từ chat service sau commit. Handshake kiểm `Origin` và cookie phiên trước khi upgrade.
- Backpressure: hàng đợi 256 frame mỗi socket, đầy thì `ResyncFrame(BACKPRESSURE)`; epoch đổi thì `EPOCH_CHANGED`; dừng server thì `SERVER_RESTART`.
- Chưa làm trong R1: push (APNs/FCM/Web Push), làn ưu tiên, badge, metrics, token phiên native trong `ClientHelloFrame` (app native ở R7/R8), kiểm tenant theo Host (một tenant tĩnh), `wsbench`.
- Sửa sau review R1 (2026-10-14): kiểm lại phiên ngay sau khi đăng ký socket và mỗi phút; tối đa 10 socket mỗi phiên, 30 mỗi user; `OpenChatFrame` 5/giây mỗi phiên; typing cần quyền gửi và không qua chặn; dispatcher và outbox sweeper không giao trùng; nhật ký chat lớn chỉ tới thành viên hiện tại; nginx `/ws` dùng zone riêng `chat_ws` (cần deploy bằng root một lần).

## Success Criteria

- Người nhận online thấy tin < 150 ms p50 (dev), chat large 100k p99 ≤ 2 s (Phase 14 đo).
- Kill Redis giữa chừng: không mất update sau `GetDifference`.
- Client gửi `OpenChat` cho chat không phải thành viên → bị từ chối, không nhận typing/presence.
- Thu hồi session → socket đóng ≤ 1 s.
- Push không gửi khi foreground; payload trên đường truyền không chứa nội dung rõ khi bật mã hoá.

## Verification

- `cd server && go test ./internal/gateway/... ./internal/push/... ./internal/presence/... -race`
- `server/tools/wsbench` mở 10k kết nối giả, đo fan-out `u:` và `c:`.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Redis pub/sub không đủ cho chat large rất đông | Trung bình | Kênh `c:` theo interest; chuyển NATS khi Phase 14 đo vượt ngưỡng |
| Hết quota FCM khi nhiều chat large hoạt động | Trung bình | Quota theo làn, gộp push theo chat, cảnh báo quota |
| iOS không xoá được thông báo chéo | Thấp | Best-effort + dọn bằng `read_inbox_max_seq` |

## Security Considerations

- Kiểm membership ở `OpenChat`; presence/typing tôn trọng `privacy_settings`.
- Token thiết bị gắn session; thu hồi session thì xoá token và khoá thiết bị.
- Khoá APNs/FCM/VAPID trong secret store (Phase 13).

## Rollback

Gateway và dispatcher là role riêng; tắt role không ảnh hưởng dữ liệu, client vẫn dùng được bằng `GetDifference`.

## Next Steps

Phase 5 dùng WS client; Phase 8, 9 dùng lanes; Phase 10, 11 đăng ký token và khoá thiết bị.
