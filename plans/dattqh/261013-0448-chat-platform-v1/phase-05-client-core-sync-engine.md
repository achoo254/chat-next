---
phase: 5
title: "Phase 5: Client core — sync engine và lưu trữ local"
status: pending
priority: P1
effort: "L"
dependencies: [1, 2, 3]
principles: [2, 4, 1, 5]
---

# Phase 5: Client core — sync engine và lưu trữ local

<!-- Updated: Red Team 2026-10-13 - topology theo nền tảng (ADR 0007) + spike native, purge local khi rời/bị kick/xoá/ẩn, epoch, thứ tự reconnect, gap 150 ms, lưu phiên theo ADR 0006 -->
<!-- Updated: Validation Session 2 2026-10-14 - module auth (OIDC qua hoandat-auth, AuthBrowser), chọn tenant trên native, dữ liệu local tách theo tenant -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - quy tắc sync khi đang lấy difference/too_long theo chat và tài khoản/entity chưa có, outbox tuần tự theo chat, phát hiện WS chết, trần media cache -->

## Goal

Viết `@app/core` bằng TypeScript thuần (không phụ thuộc React): kết nối, sync theo pts, lưu SQLite local, optimistic send, outbox offline, search local — với topology đúng cho từng nền tảng để main thread luôn rảnh vẽ.

## Context Links

- [Kỹ thuật tốc độ client web](../reports/researcher-261013-1120-telegram-web-client-speed.md)
- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 2, 2.4
- ADR 0002, 0006, 0007, 0009, 0010
- [REA Telegram Desktop 7.3.1](../reports/rea-261014-1200-telegram-desktop-architecture.md) — §1 sync, §2 lưu trữ (bằng chứng tĩnh từ binary, không phải hằng số)

## Key Insights

- Web: transport, sync, SQLite (OPFS `opfs-sahpool`) chạy trong worker; một tab giữ DB (Web Locks), tab khác gọi qua nó.
- Capacitor/Tauri: plugin native không gọi được từ Worker. Sync engine chạy trên main thread; mọi thao tác nặng gom thành **một lời gọi batch** xuống native (ghi SQL, decode lô lớn), UI nhận thay đổi gom theo frame.
- Id tạm của tin đang gửi là số thập phân sau seq thật cuối; render key giữ nguyên khi đổi sang seq thật; biểu tượng chờ chỉ hiện sau 1 s.
- Gap timer 150 ms rồi `GetDifference`; `server_epoch` đổi thì resync các chat bị ảnh hưởng.
- Cache local phải tuân thủ quyền: rời chat, bị kick, tin bị xoá/ẩn thì xoá cả bản ghi lẫn FTS.
- Telegram Desktop không lưu tin nhắn local (chỉ cache key-value mã hoá), nên khi nhận `too_long` nó tải lại từ server. Mình có SQLite nên phải định nghĩa rõ phần cache cũ thành gì sau `too_long` (Requirements dưới).

## Requirements

Functional:
- `SqlDriver` interface quanh batch nguyên tử; migrations dùng chung 3 nền tảng.
- Driver web (sqlite-wasm OPFS + Web Locks leader); driver native được Phase 10/11 hiện thực nhưng interface + spike chạy ngay ở phase này.
- Schema local: dialogs, messages, users, chats, state (pts, server_epoch, chat_pts theo chat large), outbox, `messages_fts` (FTS5 trên cột fold).
- Quy tắc sync bổ sung:
  - Khi `GetChatDifference(chat)` đang chạy, update realtime của chat đó không được áp (chỉ giữ để so pts), vì difference sẽ trả lại chúng.
  - `too_long` của một chat: tải lại cửa sổ lịch sử đang hiển thị (quanh vị trí đang xem); phần cache cũ hơn của chat đó và dòng FTS tương ứng đánh dấu `stale`, kiểm lại khi người dùng cuộn tới, không xoá rồi tải lại cả chat.
  - `too_long` mức tài khoản: xoá state, lấy snapshot dialogs mới, mọi chat trong cache chuyển sang `stale` theo quy tắc trên.
  - Update nhắc tới user hoặc chat mà client chưa có: lấy entity (hoặc `GetDifference`) trước khi render, không hiện dở.
  - Outbox xếp tuần tự theo `chat_id` cho các thao tác có thứ tự (gửi, sửa, xoá, đọc); các chat khác nhau chạy song song.
- Transport: không nhận pong hoặc frame nào trong khoảng heartbeat Phase 3 cộng biên thì coi WebSocket đã chết, kết nối lại ngay (có backoff), không chờ TCP timeout của hệ điều hành.
- Media cache local có trần dung lượng, trần thời gian và ngân sách riêng cho file lớn/video, dọn theo LRU; trần mặc định lấy từ `GetAppConfig`, người dùng chỉnh được ở cài đặt (Phase 6, 10, 11).
- Sync engine: kết nối lại theo thứ tự ADR 0002, gap detection, `GetDifference`/`GetChatDifference`, `chat_activity`, `chat_mode_changed`, `too_long`, epoch.
- Purge local khi nhận `member_removed` (của chính mình), `message_delete`, `message_hidden`; xoá media cache tương ứng.
- Ánh xạ message protocol sang model của core là chỗ duy nhất đổi id `bigint` (protobuf-es) sang `number`, gọi `assertSafeId` trước khi đổi (ADR 0001); phần còn lại của client chỉ dùng `number`.
- Event bus theo id (dialog, message key) để UI subscribe hạt mịn.
- Optimistic send + outbox offline + retry cùng `random_id`.
- Snapshot "màn hình cuối" cho cold start.
- Lưu phiên theo ADR 0006 (web: cookie HttpOnly, không giữ token trong JS).
- Module `auth` trong core:
  - Web: chuyển trang tới `/auth/login` (hoặc `?prompt=create` cho "Tạo tài khoản") kèm ngôn ngữ đang hiển thị; không tự giữ token.
  - Native: gọi `GetAuthConfig`, tạo `state` + `code_verifier`, mở trình duyệt hệ thống qua `AuthBrowser`, nhận redirect, kiểm `state`, gọi `ExchangeNativeCode`, lưu token phiên chat bằng `SecureStore`.
  - Nhận `SessionRevoked` hoặc 401 thì xoá DB local, media cache và token, quay về màn hình đăng nhập.
- Chọn tenant trên native: mặc định `chat.hoandat.com`; "Đăng nhập bằng domain khác" nhận `<d>` và dùng `chat.<d>`. DB local, media cache và `SecureStore` tách theo `(tenant, user)`, nên đổi tenant không lẫn dữ liệu. Web không cần chọn vì tenant suy từ Host.
- Validate scheme URL trước khi mở link (ADR 0004).

Non-functional:
- Mở chat từ cache p50 ≤ 50 ms, p99 ≤ 100 ms trên web; ngân sách native đo ở Phase 10/11.
- Web: không có thao tác DB hay decode protobuf trên main thread. Native: mỗi lần nhận lô update chỉ một lời gọi bridge.

## Architecture

```
Web:    main (React) <── batch theo frame ── worker [transport | sync | repo(SQLite OPFS) | search]
Native: main [transport | sync | repo-proxy] ── 1 lời gọi batch ──> native (SQLite/SQLCipher, decode)
                 └── batch theo frame ──> React
```

`startApp(platform)` là điểm DI: `SqlDriver`, `Push`, `Lifecycle`, `Notify`, `Badge`, `Files`, `SecureStore`, `OpenExternal`, `AuthBrowser` (mở trình duyệt hệ thống cho OIDC và trả URL redirect; web không dùng).

## Related Code Files

Create:
- `packages/platform/src/index.ts`
- `packages/platform-web/src/{sqlite-worker.ts,leader.ts,driver.ts}`
- `packages/core/src/{transport,sync,repo,outbox,snapshot,events,search,purge}/`
- `packages/core/migrations/*.sql`
- `packages/core/test/`
- `spikes/native-bridge/` (spike Capacitor + Tauri: ghi batch 1.000 tin, đo thời gian main thread)

## Implementation Steps

1. **Spike native trước tiên**: Capacitor (Android tầm trung + iPhone cũ) và Tauri (Windows), ghi batch 1.000 tin và decode, đo thời gian chặn main thread. Kết quả quyết định chi tiết ADR 0007 trước khi đóng interface.
2. Interface platform + driver web; Playwright trên Chromium, Firefox, WebKit.
3. Migrations + repository (upsert batch, cursor theo seq).
4. Transport WS: backoff có jitter, thứ tự kết nối lại, epoch.
5. Sync engine: hàng đợi theo pts, gap 150 ms, difference per-user và per-chat, chuyển mode.
6. Purge local theo sự kiện.
7. Event bus gom theo frame.
8. Outbox offline + optimistic send.
9. Snapshot cold start.
10. Search local FTS5 với `vifold`.
11. Test hỗn loạn: mất gói, đảo thứ tự, offline dài, 2 tab, đổi epoch, bị kick khi offline.

## Todo

- [ ] Spike native bridge + chốt ADR 0007
- [ ] Interface + driver web + leader election
- [ ] Migrations + repository
- [ ] Transport + reconnect order + epoch
- [ ] Sync engine + gap + difference + chuyển mode
- [ ] Purge local theo quyền
- [ ] Event bus
- [ ] Outbox + optimistic send
- [ ] Snapshot
- [ ] FTS5 local
- [ ] Test hỗn loạn

## Success Criteria

- 10.000 update với 5% mất gói và 5% đảo thứ tự → state cuối khớp server 100%.
- Bị kick khi đang offline, mở app → không còn tìm được tin của chat đó ở local.
- Đổi `server_epoch` → client resync, không bỏ tin.
- Hai tab: một tab ghi DB, tab kia hoạt động bình thường; đóng tab leader thì tab còn lại tiếp quản.
- Spike native: ghi batch 1.000 tin chặn main thread < 16 ms trên thiết bị tham chiếu (nếu không đạt, chuyển thêm logic xuống native trước khi sang Phase 6).

## Verification

- `pnpm --filter @app/core test`
- `pnpm --filter @app/platform-web test:e2e`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Native bridge chậm làm giật | Cao | Spike đầu phase; batch một lời gọi; đưa decode xuống native nếu cần |
| OPFS hạn chế trên Safari | Trung bình | Driver web chỉ cho trình duyệt; native dùng SQLite native |

## Security Considerations

- Web không giữ token trong JS; native dùng SecureStore.
- Purge theo quyền; xoá toàn bộ DB local khi đăng xuất.

## Rollback

`@app/core` chưa phát hành; migration local có version, cho phép reset DB local khi không tương thích.

## Next Steps

Phase 6 xây UI trên event bus; Phase 7 nối search server; Phase 10/11 hoàn thiện driver native.
