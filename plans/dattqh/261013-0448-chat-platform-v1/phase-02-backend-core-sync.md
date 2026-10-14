---
phase: 2
title: "Phase 2: Backend core — tài khoản, chat, tin nhắn, sync"
status: pending
priority: P1
effort: "XL"
dependencies: [1]
principles: [1, 2, 4, 7, 5]
---

# Phase 2: Backend core — tài khoản, chat, tin nhắn, sync

<!-- Updated: Red Team 2026-10-13 - đăng ký chỉ email, OTP hardening, lock ordering, send_dedupe, outbox log + cursor + afterCommit, epoch, sync_mode, visible_from_seq, reactions/permissions, ratelimit chuyển về đây -->
<!-- Updated: Validation Session 2 2026-10-14 - bỏ email OTP/2FA, đăng nhập qua hoandat-auth (OIDC), phiên chat gắn grant IdP + back-channel logout, tenant_id từ migration đầu -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - GetAppConfig, entity kèm update, read receipt chi tiết chỉ cho group nhỏ -->

## Goal

Dựng lõi server Go: đăng nhập đa thiết bị qua IdP `hoandat-auth` (tài khoản chung của hệ sinh thái hoandat, mỗi tenant tách riêng), chat 1-1, group, channel, toàn bộ thao tác tin nhắn và cơ chế sync học từ kiến trúc Telegram (pts + getDifference), với fast path một transaction không deadlock và không bao giờ để pts chạy lùi.

## Context Links

- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md)
- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — fast path, outbox, eager dispatch
- ADR 0001, 0002, 0003, 0004, 0006, 0010 từ Phase 1
- `hoandat-auth/docs/integration-guide.md` mục 1–5 (discovery, client, xác minh token, luồng web, back-channel logout), 8 (refresh), 11 (tenant)

## Key Insights

- `pts` cấp **trong cùng transaction** với việc ghi tin. Khoá `user_state` theo thứ tự `user_id` tăng dần trong **một** câu SQL để tránh deadlock giữa các chat có thành viên chung.
- Bot không dùng pts của người dùng; update của bot đi qua `bot_updates` do Phase 8 ghi từ outbox, nên bot không thành hot row.
- Unique index trên bảng partition phải chứa partition key; dedupe `random_id` dùng bảng riêng `send_dedupe`.
- Outbox là log có cursor riêng cho từng consumer; ngay sau commit gọi hook `afterCommit` đẩy việc thẳng vào dispatcher trong process (realtime, push, bot, webhook), sweeper 200 ms chỉ nhặt việc bị rơi.
- Postgres chạy replica đồng bộ (quorum); `server_epoch` tăng mỗi lần failover hoặc restore để client tự resync.
- IdP không nằm trên đường nóng: RPC và WS chỉ kiểm phiên chat (hash token tra Redis/Postgres). IdP chỉ được gọi khi đăng nhập, refresh định kỳ và nhận back-channel logout, nên IdP chậm hay sập không làm chậm gửi tin; chỉ chặn đăng nhập mới.
- Refresh token IdP dùng một lần và xoay vòng: hai lần refresh song song cùng token làm IdP thu hồi cả grant, nên refresh phải khoá theo phiên và lưu token mới trước khi nhả khoá.

## Requirements

Functional:
- Xem trước link (R1, chỉ chữ): server lấy trang ngoài với chặn SSRF (từ chối IP private, loopback, link-local; kiểm lại IP sau khi resolve để chống DNS rebinding; chỉ http/https; giới hạn kích thước, thời gian, số lần chuyển hướng), đọc Open Graph lấy site, tiêu đề, mô tả, cache theo URL; người gửi bỏ được xem trước khi soạn. Ảnh thumbnail thêm ở Phase 4 (R3).
- Nhóm có topic (R1, Validation Session 11): topic là thuộc tính của nhóm; tin mang `topic_id` trong seq của nhóm, sync và difference không đổi; bảng topic (tiêu đề, màu icon, ghim, đóng, ẩn), topic "Chung" mặc định; vị trí đã đọc và số chưa đọc theo (user, chat, topic); RPC tạo, sửa, đóng, ẩn, liệt kê topic; update `topic_changed`.
- Đăng nhập **chỉ qua IdP `hoandat-auth`** theo ADR 0006: app chat không có đăng ký, mật khẩu, OTP, 2FA hay gửi email. Nút "Tạo tài khoản" gửi `prompt=create`; mọi trang đăng nhập/đăng ký là của IdP, có `ui_locales` theo ngôn ngữ app.
  - Web (`chat-web`): `/auth/login` tạo `state`, `nonce`, `code_verifier` lưu tạm phía server; `/auth/callback` đổi code, kiểm ID token (`iss` của tenant, `aud`, `nonce`, ES256), lấy `sub`, `sid`; tạo phiên chat gắn `(tenant_id, sub, sid)`.
  - Native (`chat-mobile`, `chat-desktop`): `ExchangeNativeCode(code, code_verifier, redirect_uri, client_id)` đổi code ở token endpoint của tenant rồi cấp phiên chat; chỉ chấp nhận `redirect_uri` đúng mẫu của client đó.
  - `POST /auth/backchannel-logout`: xác minh logout token (`typ: logout+jwt`, `aud` là `chat-web`, `maxTokenAge` 2 phút, có `events` back-channel, không có `nonce`, bỏ trùng theo `jti`), thu hồi mọi phiên gắn `sid` (không có `sid` thì theo `sub`), trả 200; token sai trả 400.
  - Lần đầu thấy `(tenant_id, sub)`: tạo user với `preferred_username` (trùng thì thêm hậu tố và cho user đổi), `name`, `picture`. Mỗi lần đăng nhập và refresh: đọc lại `email` + `email_verified`; email chưa xác minh hoặc bị gỡ thì xoá email đã lưu.
  - Có thiết bị mới đăng nhập thì các thiết bị khác của user nhận push và thấy cảnh báo ở danh sách phiên.
- Session đa thiết bị: token opaque 256-bit lưu hash; bảng `user_sessions` có `tenant_id`, `idp_sid`, `idp_client_id`, refresh token IdP mã hoá cột, `idp_checked_at`; cookie `__Host-` cho web theo ADR 0006; kiểm tra `Origin` theo allowlist của tenant ở mọi RPC thay đổi trạng thái; thu hồi phát `session_revoked`.
  - Hạn phiên đi theo grant IdP: web trượt 30 ngày, trần 90 ngày; native trượt 30 ngày, không trần (grant theo thiết bị, refresh token theo chính sách client của IdP).
  - Kiểm grant: refresh dưới mutex theo phiên khi WS kết nối lại mà `idp_checked_at` quá 1 giờ, và job nền mỗi 24 giờ; `invalid_grant` thu hồi phiên. Lỗi mạng hoặc 5xx từ IdP không thu hồi phiên, chỉ thử lại có backoff.
  - `SignOut`: xoá phiên chat, thu hồi refresh token ở `revocation_endpoint`; web trả URL `end_session_endpoint` với `id_token_hint`.
- Tenant theo ADR 0010: middleware chọn tenant theo Host trước mọi handler; `tenant_id` trên `users`, `chats`, `invite_links` và mọi chỉ mục unique (`(tenant_id, idp_sub)`, `(tenant_id, username)`). Mọi truy vấn user/chat lọc theo tenant; thêm thành viên khác tenant bị từ chối ở cùng truy vấn kiểm quyền.
- Client tenant (`server/internal/tenant`): tra tenant qua API nội bộ của IdP (`/internal/tenants/lookup`, `/internal/tenants/<id>`, JWKS, discovery), cache theo tenant, dùng bản cũ khi IdP lỗi, chỉ cache âm khi IdP trả 404. Tenant chính `hoandat.com` cấu hình tĩnh, không cần IdP lúc chạy.
- Hồ sơ: tên, username duy nhất trong tenant, avatar, bio; email không bao giờ lộ cho người khác trừ khi cài đặt cho phép.
- Bảng `privacy_settings` với mặc định an toàn (last seen: danh bạ; ai tìm tôi bằng email: không ai; ai thêm tôi vào group: danh bạ; ai nhắn tôi: mọi người) — Phase 12 mở rộng UI và luật.
- Chat: private, group (một loại duy nhất), channel; tạo, mời, rời, kick; vai trò admin; quyền thành viên dạng bitmask (gửi tin, gửi media, thêm thành viên, ghim, đổi thông tin); invite link entropy ≥ 128 bit, có hạn và giới hạn lượt dùng tuỳ chọn, xác nhận trước khi tham gia; `history_visibility` (mặc định thành viên mới xem được lịch sử, admin có thể tắt) qua `chat_members.visible_from_seq`.
- `sync_mode` theo chat: `small` (≤ 200 thành viên, fan-out on write) và `large` (log per-chat); chuyển một chiều khi vượt ngưỡng theo ADR 0002; ngưỡng chỉ áp dụng cho chat mới khi đổi cấu hình.
- Tin nhắn: gửi text/entities, reply, forward, copy, sửa (tăng `edit_version`), xoá cho mình (`user_hidden_messages`) hoặc cho mọi người, đánh dấu đã đọc, ghim, reaction (`message_reactions`), album (`grouped_id`), lưu `reply_markup`, `via_bot_id`.
- Sync: `GetState`, `GetDialogs`, `GetHistory` (cursor theo seq, tôn trọng `visible_from_seq` và tin bị ẩn), `GetDifference`, `GetChatDifference`, `too_long`, `server_epoch`; update `chat_activity` gộp cho chat `large`.
- Outbox theo ADR 0003: enum `kind` gồm `message_new`, `message_edit`, `message_delete`, `message_hidden`, `reaction`, `read`, `pin`, `member_added`, `member_removed`, `member_permissions`, `chat_mode_changed`, `chat_updated`, `inline_button`, `session_revoked`; mọi mutation đều ghi outbox trong tx.
- Package `server/internal/ratelimit` (token bucket Redis, tầng cấu hình) dùng chung cho mọi phase sau.
- `GetAppConfig(hash)`: giới hạn và timer do server cấp theo tenant (độ dài tin, thời hạn sửa tin, trần thành viên nhận read receipt chi tiết, độ trễ thông báo desktop, trần media cache gợi ý); trả "không đổi" khi `hash` khớp. Client không hardcode các giá trị này.
- Update realtime mang entity tối thiểu (tên, ảnh) của user/chat mà người nhận có thể chưa có, để client không phải render dở.
- Danh sách "ai đã đọc" từng thành viên chỉ có ở group không vượt ngưỡng thành viên (từ `GetAppConfig`) và trong một khoảng ngày; group lớn hơn chỉ có `read_outbox_max_seq`.

Non-functional:
- Send → ack p50 ≤ 60 ms, p99 ≤ 250 ms (đã tính chi phí commit đồng bộ tới standby trong cùng DC).
- Server stateless, scale ngang.
- Update log giữ 30 ngày (cấu hình); client cũ hơn nhận `too_long`.
- Interceptor RPC và encoder JSON gọi `protoids.Check` cho mọi response và mọi request (id do client chọn như `random_id` cũng phải < 2^53).
- Mỗi process cấp Snowflake phải thuê số worker (lease trong Postgres hoặc Redis, kèm mốc ms cao nhất đã cấp) để hai process không bao giờ dùng chung worker.
- Partition `outbox` giữ 30 ngày (ADR 0003); cảnh báo khi cursor của consumer nào trễ quá vài phút.
- RPC sẽ thêm vào proto ở phase này (thêm mới không phá contract): `CheckInvite` (xem trước group trước khi tham gia) và danh sách "ai đã đọc" cho group nhỏ.

## Architecture

```
server/internal/
├─ auth/          # OIDC client (web + native), phiên chat, back-channel logout, job kiểm grant
├─ tenant/        # chọn tenant theo Host, client API nội bộ IdP, cache discovery/JWKS
├─ users/ privacy/ chats/ messages/ updates/
├─ outbox/       # ghi trong tx, cursor theo consumer, afterCommit hook, sweeper, partition theo ngày
├─ ratelimit/
├─ store/        # pgx, WithTx, migration, epoch
└─ rpc/
```

Fast path gửi tin (một transaction):

1. Kiểm tra quyền gửi (membership, bitmask, ban) trong cùng truy vấn.
2. `INSERT send_dedupe (sender_id, random_id) ON CONFLICT DO NOTHING RETURNING` — trùng thì đọc tin cũ, trả lại.
3. `UPDATE chats SET last_seq = last_seq + 1 ... RETURNING last_seq`; `INSERT messages`.
4. Chat `small`: `UPDATE user_state SET pts = pts + 1 FROM (SELECT unnest($member_ids ORDER BY user_id)) ... RETURNING user_id, pts` rồi một `INSERT user_updates` nhiều dòng (bỏ qua thành viên là bot). Chat `large`: tăng `chat_pts`, `INSERT chat_updates`.
5. `INSERT outbox (kind, chat_id, ...)`.
6. Commit (đồng bộ tới standby) → trả `{chat_id, seq, pts, server_epoch, date}` → `afterCommit` đẩy việc vào dispatcher.

Bảng chính: `tenants` (bản cache id, domain, trạng thái từ IdP), `users` (`tenant_id`, `idp_sub`, `is_bot`), `user_sessions` (`idp_sid`, refresh token IdP mã hoá), `oidc_logout_jti` (TTL 10 phút), `privacy_settings`, `blocks`, `chats` (`tenant_id`, `type`, `sync_mode`, `last_seq`, `chat_pts`, `history_visibility`), `chat_members` (`role`, `permissions`, `visible_from_seq`), `messages` (PARTITION BY HASH(chat_id), 64 partition), `send_dedupe` (TTL 7 ngày), `user_hidden_messages`, `message_reactions`, `message_reads`, `user_state` (pts), `user_updates` / `chat_updates` (PARTITION BY RANGE theo ngày), `outbox` (PARTITION BY RANGE theo ngày), `outbox_cursors`, `server_meta` (`server_epoch`), `invite_links`.

## Related Code Files

Create:
- `server/internal/{auth,tenant,users,privacy,chats,messages,updates,outbox,ratelimit,store,rpc}/`
- `server/migrations/0001_init.sql` …
- `server/internal/store/testdb/` (testcontainers, có cấu hình primary + sync standby)
- `server/internal/auth/idptest/` (IdP giả cho unit test: discovery, JWKS, token endpoint, logout token; test tích hợp dùng IdP thật từ Docker Compose dev)

## Implementation Steps

1. Store: pgx pool, `WithTx`, migration tool (goose), testcontainers; đọc/ghi `server_epoch`.
2. Migration schema; job tạo/xoá partition theo ngày cho `user_updates`, `chat_updates`, `outbox`.
3. Ratelimit (token bucket Redis, tầng).
4. Tenant: middleware chọn theo Host, client API nội bộ IdP, cache.
5. Auth OIDC: web Code + PKCE, `ExchangeNativeCode`, back-channel logout, refresh có mutex, job kiểm grant, sign out + revocation; phiên chat + cookie/Origin + `session_revoked`.
6. Users, username, privacy_settings mặc định, block.
7. Chats + quyền bitmask + invite link + history visibility + `sync_mode` và thủ tục chuyển mode.
8. Messages: fast path ở trên, edit, delete (mình/mọi người), forward, copy, reply, read, pin, reaction, album.
9. Updates: `GetState`, `GetDifference`, `GetChatDifference`, `chat_activity`, `too_long`.
10. Outbox: cursor theo consumer, `afterCommit` hook, sweeper `FOR UPDATE SKIP LOCKED` chỉ trong phạm vi shard của consumer.
11. Test:
    - property test pts: 1.000 tin song song vào 1 chat;
    - **đa chat**: 20 chat mỗi chat 150 thành viên, chồng chéo 30%, gửi song song → 0 deadlock, pts liên tục;
    - hot user: một user trong 100 group nhận 2.000 tin/s → p99 trong ngân sách;
    - chuyển `sync_mode` giữa luồng gửi → không mất, không lặp tin;
    - failover: promote standby, tăng epoch → client giả lập phát hiện và resync, không bỏ tin;
    - auth: logout token sai `aud`/`typ`/hết hạn/phát lại bị từ chối; hai refresh song song cùng phiên chỉ gọi IdP một lần; IdP trả `invalid_grant` thì phiên bị thu hồi, IdP 5xx thì không;
    - tenant: user tenant A không đọc, tìm hay thêm được user/chat của tenant B; host lạ trả `421`.

## Todo

- [ ] Store + migration + partition job + epoch
- [ ] Ratelimit
- [ ] Tenant theo Host + client API nội bộ IdP + cache
- [ ] Auth OIDC web/native + back-channel logout + kiểm grant + phiên + Origin + revoke
- [ ] Users/privacy mặc định/block
- [ ] Chats + quyền + invite + history visibility + sync_mode
- [ ] Messages đầy đủ (edit/delete/forward/copy/read/pin/reaction/album)
- [ ] Updates + chat_activity + too_long
- [ ] Outbox log + cursor + afterCommit + sweeper
- [ ] Bộ test pts, đa chat, hot user, chuyển mode, failover, auth, tenant

## Success Criteria

- Mọi test ở bước 11 pass với `-race`.
- Retry cùng `random_id` 100 lần chỉ tạo một tin.
- Đăng nhập web và native chạy được với IdP local; đăng xuất ở IdP (hoặc thu hồi phiên ở `/account`) thì phiên chat web bị thu hồi và socket đóng trong ≤ 1 s (test cùng Phase 3); thu hồi thiết bị native ở `/account` thì phiên native bị thu hồi ở lần kiểm grant kế tiếp.
- IdP dừng hẳn: phiên đang có vẫn gửi/nhận tin trong ngân sách; chỉ đăng nhập mới lỗi với thông báo rõ.
- Thu hồi session thì socket đang mở bị đóng trong ≤ 1 s (test cùng Phase 3).
- Benchmark fast path p99 < 20 ms trên Postgres local có sync standby.

## Verification

- `cd server && go test ./... -race -count=1`
- `cd server && go test ./internal/messages -bench . -benchtime 10s`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Commit đồng bộ tăng latency | Trung bình | Standby cùng DC; đo trong ngân sách; quorum để một standby treo không chặn ghi |
| Chat rất đông người gửi nghẽn trên `chats.last_seq` | Trung bình | Đo ở Phase 14; micro-batch 5–10 ms cho chat nóng nếu cần |
| IdP chậm hoặc sập | Trung bình | IdP không nằm trên đường nóng; phiên đang có chạy tiếp; lỗi IdP không thu hồi phiên |
| Refresh song song làm IdP thu hồi grant | Cao | Mutex theo phiên (Redis lock), lưu token mới trước khi nhả khoá; test song song |
| Rate limit 60 request/phút ở `/token` của IdP chặn job kiểm grant | Cao | Gọi `/token` thẳng qua loopback để vào bucket riêng của IdP (plan `hoandat-auth` phase 03); job vẫn trải đều theo thời gian |
| Thu hồi thiết bị native ở `/account` không được báo ngay | Thấp | Kiểm grant khi kết nối lại (≤ 1 giờ) + job 24 giờ; ghi rõ trong docs bảo mật |

## Security Considerations

- Token phiên chỉ lưu hash, so sánh constant-time. Refresh token IdP mã hoá cột, không bao giờ trả cho client hay ghi log.
- `state`, `nonce`, `code_verifier` dùng một lần, sống 10 phút; callback từ chối `state` lạ hoặc đã dùng.
- Mọi handler kiểm tra membership/quyền theo `chat_id` trong cùng truy vấn.
- Email (lấy từ IdP) lưu mã hoá cột + hash có khoá để tra cứu `SearchUsers` theo email ngay từ migration đầu (không phải migrate sau).

## Rollback

Migration có file down; backup (`pg_dump`/snapshot) trước mọi migration trên môi trường dùng chung. Role binary tắt độc lập.

## Next Steps

Phase 3 tiêu thụ outbox qua `afterCommit`; Phase 4 thêm media; Phase 5 dùng RPC; Phase 8 thêm consent bot vào fast path.
