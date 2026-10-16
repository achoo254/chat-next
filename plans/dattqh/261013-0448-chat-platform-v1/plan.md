---
title: "Nền tảng chat v1 — hiệu năng và kiến trúc học từ Telegram"
description: "Sản phẩm app tiếp theo trong hệ sinh thái hoandat (đăng nhập qua IdP hoandat-auth). Ứng dụng chat tên cấu hình được, web-first, đóng gói Capacitor/Tauri, nhanh ngang Telegram, có nền tảng Bot riêng, tìm kiếm lịch sử và thông báo qua Bot/webhook cực nhanh."
status: in-progress
priority: P1
effort: "XL"
branch: main
tags: [feature, frontend, backend, api, database, infra, critical]
blockedBy: []
blocks: []
created: 2026-10-13
---

# Nền tảng chat v1

## Overview

Sản phẩm chat là **app tiếp theo trong hệ sinh thái hoandat**, cùng hàng với Localman và Tunelo, dùng chung IdP `hoandat-auth` (xem mục [Hệ sinh thái hoandat](#hệ-sinh-thái-hoandat)). Tên sản phẩm cấu hình được (`{{APP_NAME}}` trong `brand.config.json`; "chat-inet" chỉ là tên thư mục). Telegram chỉ là chuẩn tham chiếu về hiệu năng và kiến trúc; sản phẩm độc lập với Telegram, không tương thích và không liên quan Telegram về API, tên gọi hay thương hiệu.

Stack đã chốt: web app React 19 (web-first), Capacitor cho iOS/Android, Tauri v2 cho desktop, backend Go, Postgres + Redis + Meilisearch + S3-compatible, self-host tại Việt Nam. Hạ tầng hai giai đoạn: chạy chung server `.65` với IdP trước, chuyển lên cụm riêng (Postgres replica đồng bộ) khi chạm ngưỡng tải (Phase 13). Ứng dụng công khai, đăng nhập bằng tài khoản hoandat (Google/GitHub qua `hoandat-auth`), hỗ trợ tenant theo domain, contract dữ liệu thiết kế cho hàng triệu người dùng; v1 triển khai cỡ ~100k.

Đầu vào: [báo cáo tổng hợp xia](../reports/xia-261013-1139-telegram-like-chat-design.md), 5 báo cáo nghiên cứu trong `../reports/`, và [báo cáo REA về Telegram Desktop 7.3.1](../reports/rea-261014-1200-telegram-desktop-architecture.md) (kiểm kê tĩnh binary đã cài, không decompile, không chạy app).

## Hệ sinh thái hoandat

App chat là một sản phẩm trong hệ sinh thái hoandat, không phải sản phẩm đứng riêng. Danh tính người dùng do IdP OpenID Connect `hoandat-auth` quản lý (repo [`achoo254/hoandat-auth`](https://github.com/achoo254/hoandat-auth), bản local `../../../../hoandat-auth`, production `https://auth.hoandat.com`). Đây là IdP đang phục vụ các app hiện có:

| App trong hệ sinh thái | Địa chỉ | `client_id` |
|---|---|---|
| Localman web, Localman MCP | `https://localman.hoandat.com` | `localman-web`, DCR |
| Tunelo CLI, Tunelo web | lệnh `tunelo`, `https://tunnel.hoandat.com` | `tunelo-cli`, `tunelo-web` |
| **App chat (plan này)** | `https://chat.hoandat.com` (tenant: `https://chat.<d>`) | `chat-web`, `chat-mobile`, `chat-desktop` |

Những điều sau là ràng buộc của hệ sinh thái mà plan này phải tuân theo. Nguồn: `hoandat-auth/README.md` và `hoandat-auth/docs/integration-guide.md`.

- Một tài khoản hoandat dùng cho mọi app. App chat không tự quản lý danh tính gốc; tài khoản chat gắn với `sub` của IdP.
- IdP chỉ cho đăng nhập và đăng ký bằng Google hoặc GitHub. Không có mật khẩu, không có mã khôi phục, và IdP không gửi email ở bất kỳ đâu (ADR 0004 của `hoandat-auth`).
- App mới phải khai client tĩnh trong `hoandat-auth/src/oidc/clients.ts` (Code + PKCE S256 bắt buộc, redirect `/auth/callback`, back-channel logout có `sid`). Sau đó cập nhật bảng ứng dụng trong README, trang `/apps`, mục "Client và audience" và `docs/integration-guide.md` mục 2. Phần này là thay đổi ở repo `hoandat-auth`, không nằm trong repo này.
- Endpoint đọc từ `/.well-known/openid-configuration`, không hardcode. Access token là JWT ES256 sống 15 phút, xác minh offline bằng JWKS và kiểm `iss`, `aud`, `typ`. Refresh token dùng một lần và xoay vòng, phiên trượt 30 ngày, trần 90 ngày. Client phải khoá khi refresh.
- Hệ sinh thái có tenant theo domain (ADR 0006 của `hoandat-auth`): người dùng của `<domain>` đăng nhập ở `auth.<domain>` và dữ liệu tách khỏi `hoandat.com`. Tenant đầu tiên là `inetdev.io.vn`.
- Trang `/account` của IdP là nơi người dùng xem phiên, thiết bị và gỡ quyền ứng dụng. Gỡ quyền hoặc đăng xuất ở IdP phải cắt được phiên của app chat qua back-channel logout.

### Cách app chat tham gia hệ sinh thái (đã chốt ngày 2026-10-14)

- **Đăng nhập:** chỉ qua `hoandat-auth`. App chat không có đăng ký, mật khẩu, OTP, 2FA hay gửi email. Web dùng client confidential `chat-web` (server làm Code + PKCE). Mobile dùng client public `chat-mobile` (trình duyệt hệ thống + private-use scheme), desktop dùng `chat-desktop` (trình duyệt hệ thống + loopback). Chi tiết ở ADR 0006, [Phase 1](./phase-01-contracts-foundation.md).
- **Phiên:** app tự cấp phiên chat để IdP không nằm trên đường nóng, nhưng phiên luôn gắn với grant của IdP. Phiên bị thu hồi khi nhận back-channel logout hoặc khi refresh trả `invalid_grant`. Phiên web trượt 30 ngày, trần 90 ngày; phiên native trượt 30 ngày, không trần (grant theo thiết bị, như `tunelo-cli`). Xem [Phase 2](./phase-02-backend-core-sync.md).
- **Domain:** `chat.hoandat.com` cho tenant chính. Mỗi tenant `<d>` dùng `chat.<d>` (webhook ở `chat.<d>/hook/…`, Bot API ở `chat.<d>/bot/v1/…`); media và Mini App nằm trên domain đăng ký riêng, dùng chung mọi tenant.
- **Tenant:** có từ v1 (ADR 0010). `tenant_id` có từ migration đầu; không có chat, tin, bot hay tìm kiếm xuyên tenant. Một bản app mobile/desktop dùng cho mọi tenant ("Đăng nhập bằng domain khác"). Tenant nghiệm thu là `inetdev.io.vn`.

### Thay đổi cần làm ở `hoandat-auth`

Plan riêng ở repo đó: `hoandat-auth/plans/dattqh/261014-1131-chat-app-integration/plan.md` (4 phase, vị trí code đã scout). Phase 04 của plan đó nghiệm thu cùng Phase 2 của plan này.

| Thay đổi | Lý do | Phase chat cần |
|---|---|---|
| Khai client tĩnh `chat-web` (confidential, back-channel logout `https://chat.<d>/auth/backchannel-logout`, scope `openid profile email`) | Đăng nhập web | 2 |
| Khai `chat-mobile` (native, redirect private-use scheme) và `chat-desktop` (native, loopback cổng bất kỳ theo RFC 8252); refresh token theo chính sách client, không trần 90 ngày như `tunelo-cli` | Đăng nhập native, phiên dài trên thiết bị | 10, 11 |
| Thêm host `chat.<d>`, `*.chat.<d>` vào quy ước host của tenant, bật theo từng tenant ở `/admin`; chặn nhãn `chat` khi nhận domain; cấp chứng chỉ cho tenant đã bật | Tenant theo domain | 2, 13 |
| Credentials API nội bộ cho vai `chat` (backend chat chạy chung server `.65` nên gọi qua loopback, không cần kênh từ xa) | Backend chat tra tenant, JWKS, discovery | 2, 13 |
| Khoá app `chat-web` để suy secret theo tenant | Tenant mới không cần cấu hình tay | 2 |
| Bucket hạn mức riêng ở `/token` cho request vào thẳng IdP qua loopback | Job kiểm grant cho nhiều phiên | 2, 14 |
| Thêm app chat vào bảng README, trang `/apps`, `docs/integration-guide.md` | Quy ước khi thêm app mới | 14 |

## Yêu cầu tối thiểu (không được cắt)

1. Tốc độ cực nhanh ngang Telegram — Phase 2, 3, 5, 6, 14.
2. Nền tảng Bot mạnh ngang Telegram, API riêng — Phase 8, 15.
3. Tìm kiếm lịch sử tin nhắn, gõ không dấu vẫn ra — Phase 7.
4. Gửi thông báo qua Bot và webhook, xử lý cực nhanh — Phase 9.

## Nguyên tắc sản phẩm

(1) Core first · (2) Speed matters · (3) Simple by default · (4) Cloud-enabled · (5) Privacy by design · (6) Platform over features · (7) Scale from the beginning. Mỗi phase ghi nguyên tắc chính trong frontmatter `principles`.

## Phases

| # | Phase | Tier | Phụ thuộc | Nguyên tắc | Status |
|---|---|---|---|---|---|
| 1 | [Chốt contract và nền móng monorepo](./phase-01-contracts-foundation.md) | L | — | 1, 6, 7, 3, 5 | Done (Compose dev chưa chạy: máy không có Docker) |
| 2 | [Backend core — tài khoản, chat, tin nhắn, sync](./phase-02-backend-core-sync.md) | XL | 1 | 1, 2, 4, 7, 5 | In progress (R1 lên prod; còn tenant theo Host, test hot user/failover) |
| 3 | [Realtime gateway và push](./phase-03-realtime-gateway-push.md) | L | 2 | 2, 4, 7, 5 | In progress (WS gateway R1; Web Push cho PWA lên prod 2026-10-16; push native ở R7) |
| 4 | [Media pipeline](./phase-04-media-pipeline.md) | L | 2, 6, 13 | 2, 4, 5, 7 | In progress (R3 lên prod: lưu trên đĩa .65; còn tạm dừng upload, grouped_id khi chuyển tiếp, ffmpeg) |
| 5 | [Client core — sync engine và lưu trữ local](./phase-05-client-core-sync-engine.md) | L | 1, 2, 3 | 2, 4, 1, 5 | In progress (web xong; native ở R7/R8) |
| 6 | [Web UI React 19 và ngân sách tốc độ](./phase-06-web-ui-speed-budget.md) | XL | 5 | 2, 3, 1 | In progress (UI R1 lên prod; còn React Compiler, perf gate CI) |
| 7 | [Tìm kiếm lịch sử tin nhắn](./phase-07-message-history-search.md) | L | 2, 5 | 2, 3, 5, 7 | In progress (R4 lên prod: Postgres pg_trgm chuỗi con + tsvector; Meilisearch để giai đoạn scale) |
| 8 | [Bot API core (8a)](./phase-08-bot-platform.md) | XL | 2, 3, 4, 6 | 6, 2, 3, 5 | In progress (R5 lên prod: đủ method trừ inline mode và bulk; webhook, safehttp, dead-letter, test hợp đồng OpenAPI, bot trợ lý) |
| 15 | [SDK bot và Developer Console (8b)](./phase-15-bot-sdk-developer-console.md) | L | 8 | 6, 3 | In progress (Console lên prod: hồ sơ, token, nhận update, update lỗi, số liệu, lệnh; còn SDK TS/Python/Go) |
| 16 | [Mini App](./phase-16-mini-app.md) | L | 8, 15 (mobile/desktop: 10, 11) | 6, 5, 3 | Pending |
| 9 | [Thông báo qua Bot và incoming webhook](./phase-09-notification-webhook-pipeline.md) | L | 2, 3 (phần bot: 8) | 2, 6, 3, 7 | In progress (R2 lên prod: incoming webhook; phần bot ở R5) |
| 10 | [Ứng dụng mobile bằng Capacitor](./phase-10-mobile-capacitor.md) | L | 3, 6 | 4, 2, 3 | Hoãn (user 2026-10-15: PWA + Web Push trước; Capacitor khi cần App Store/Play) |
| 11 | [Ứng dụng desktop bằng Tauri v2](./phase-11-desktop-tauri.md) | L | 3, 6 | 4, 2, 3 | Hoãn (cùng quyết định với Phase 10) |
| 12 | [Quyền riêng tư, an toàn, chống lạm dụng](./phase-12-privacy-safety-anti-abuse.md) | L | 2, 3, 7, 8, 9 | 5, 3, 7 | In progress (R1 + xuất dữ liệu, xoá tài khoản ân hạn 30 ngày, tự xoá khi không dùng lên prod 2026-10-16; còn chống lạm dụng đầy đủ, đánh giá ND13) |
| 13 | [Hạ tầng self-host và observability](./phase-13-infra-observability.md) | L | 1, 2 (chạy song song) | 7, 2, 4, 5 | In progress (GĐ1 trên .65; CI GitHub Actions đang bị chặn vì thanh toán, deploy bằng root) |
| 14 | [Load test và sẵn sàng phát hành](./phase-14-load-test-launch-readiness.md) | M | 2–13, 15, 16 | 2, 7, 1 | Pending |

Phase là luồng việc kỹ thuật; thứ tự làm và đưa lên prod theo mục "Lộ trình phát hành" dưới đây. Mỗi release lấy đúng phần cần của các phase liên quan. Phase 15 mang số 15 vì được tách ra sau; về logic nó là 8b.

## Lộ trình phát hành liên tục

User quyết định ngày 2026-10-14: review từng giai đoạn ngay trên prod thay vì làm xong hết mới xem; sản phẩm phải có người dùng thật từ sớm; trong giai đoạn thiết kế và đưa lên prod, user cho phép **deploy prod liên tục**.

Cách làm cho mọi release:
- Mỗi release là một lát dọc chạy được từ đầu tới cuối, lên `https://chat.hoandat.com` (server `.65`, giai đoạn 1 của Phase 13), không phải bản nháp trên staging.
- Commit lên `main` qua đủ kiểm tra thì tự deploy prod; smoke test tự động trên prod, đỏ thì tự rollback. Một release có thể gồm nhiều lần deploy.
- Không dùng feature flag khi chưa có người dùng thật: tính năng hiện ngay khi deploy. Chỉ thêm flag theo tenant/người dùng khi đã có người dùng thật (từ R9).
- Migration theo kiểu expand/contract, backup Postgres trước mỗi migration, để deploy liên tục không làm hỏng dữ liệu của người dùng thật.
- Trước khi code UI của release: user duyệt các màn tương ứng trong [mock](./mockups/index.html). Sau khi lên prod: user và nhóm dùng thử test trên prod, phản hồi vào chính app chat (từ R1) để sửa ở các lần deploy sau.
- Khi chuyển release: release trước phải chạy ổn trên prod với người dùng thật, không có lỗi chặn.
- Tăng trưởng theo nhóm, không theo từng người lẻ: người dùng đầu tiên là cả một nhóm vào cùng lúc (đội nội bộ, đội vận hành, tenant theo domain), nhờ link mời nhóm và cảnh báo webhook có giá trị ngay khi chưa ai nhắn tin. Người dùng mới chưa có ai thì vẫn có Cloud của tôi và lời mời đồng đội (R3b), từ R5 có thêm bot chính thức.

| Release | Lên prod để review | Phase (phần) | Người dùng thật |
|---|---|---|---|
| R0 | Khung trên prod: đăng nhập bằng tài khoản hoandat (web), app trống, hồ sơ, phiên đăng nhập, đăng xuất; pipeline deploy và smoke test | 1, 2 (auth, user, tenant chính), 6 (khung), 13 (GĐ1, CI/CD), `hoandat-auth` Phase 02–04 cho tenant chính | User |
| R1 | Nhắn tin chữ realtime: 1-1, nhóm, nhóm có topic, kênh, trả lời, sửa, xoá, reaction, đã đọc, ghim, link mời, quản trị nhóm; chặn, báo cáo, rate limit, quyền riêng tư cơ bản; hàng đợi kiểm duyệt tối thiểu; thông báo trình duyệt khi tab mở | 2, 3 (gateway, chưa push), 5 (web), 6, 12 (phần tối thiểu) | Nhóm nội bộ hoandat |
| R2 | Webhook cảnh báo: Grafana, Alertmanager, GitLab, Uptime Kuma, Jenkins đẩy vào nhóm; cảnh báo cập nhật tại chỗ | 9 (incoming webhook) | Nhóm vận hành |
| R3 | Media: ảnh, video, file, voice, album, trình xem, tải lên tiếp tục | 4, 13 (S3/CDN) | Nhóm nội bộ |
| R3b | Người dùng mới: "Cloud của tôi" ghim đầu danh sách (chat với chính mình, đồng bộ mọi máy), màn trống "Tạo nhóm và mời", link mời ngay sau khi tạo nhóm. Làm song song với R3, bản đầu chỉ có chữ; file vào được khi R3 lên prod. Trước đó: E2E nhiều người dùng trên stack local (Phase 14) | 2, 6, 14 (E2E) | Nhóm nội bộ |
| R4 | Tìm kiếm không dấu, local + server | 7 | Nhóm nội bộ |
| R5 | Bot, Developer Console, SDK TS/Python/Go, thông báo và gửi hàng loạt qua bot; bot chính thức chào người dùng mới ở lần đăng nhập đầu | 8, 15, 9 (phần bot) | Nhóm nội bộ, dev viết bot |
| R6 | Mini App trên web | 16 (web) | Dev viết bot |
| R7 | App iOS/Android, push, Mini App trên mobile | 10, 3 (push), 16 (mobile) | Nhóm nội bộ |
| R8 | App desktop, Mini App trên desktop | 11, 16 (desktop) | Nhóm nội bộ |
| R9 | Mở công khai: chống lạm dụng đầy đủ, xuất/xoá dữ liệu, đánh giá Nghị định 13, tenant thứ hai (`inetdev.io.vn`), load test lượt 1 và checklist phát hành | 12, 14, tenant theo domain | Công khai |

Trạng thái ngày 2026-10-14:
- Phase 1 đã xong, CI GitHub Actions xanh. Còn mở: chạy Compose dev, vì máy dev không có Docker.
- R0 đã lên prod. Release đầu `20261014-092434-30ec13025bf6` đã có người đăng nhập thật, đặt username, sửa hồ sơ và xem danh sách phiên, tất cả trả 200. Deploy tự động từ `main` đi qua user `chat-deploy` bị giới hạn quyền ([docs/deployment-guide.md](../../../docs/deployment-guide.md)).
- Đang làm song song: sửa các lỗi review của backend R0 (giữ refresh token xoay vòng, không giữ transaction trong lúc gọi IdP, thu hồi `id_token` khi revoke) và Phase 5 phần web cho R1.
- Việc tiếp theo là R1. Muốn bắt đầu UI R1 (Phase 6) thì user phải duyệt các màn R1 trong mock trước. Khi tải chạm ngưỡng ở Phase 13, chuyển lên cụm riêng (giai đoạn 2) độc lập với thứ tự release.

## Ngân sách tốc độ (mục tiêu, đo ở Phase 14)

| Chỉ số | p50 | p99 |
|---|---|---|
| Gửi → ack | ≤ 60 ms | ≤ 250 ms |
| Tới người nhận online (chat small) | ≤ 150 ms | ≤ 500 ms |
| Tới session đang mở chat large 100k | — | ≤ 2 s |
| Mở chat từ cache | ≤ 50 ms | ≤ 100 ms |
| Tìm kiếm | ≤ 100 ms | ≤ 500 ms |
| Gửi → tìm được | ≤ 1 s | ≤ 5 s |
| Webhook POST → 200 | ≈ 15 ms | ≈ 50 ms |
| Webhook → client online | ≤ 100 ms | ≤ 300 ms |
| Push được FCM/APNs nhận | ≤ 200 ms | ≤ 1 s |

## Success Criteria

- [ ] Mọi chỉ số trong bảng ngân sách đạt ở mức tải an toàn đã chốt trên `.65` trước khi ra mắt, và ở quy mô ~100k sau khi lên cụm riêng (Phase 13, 14).
- [ ] Bot mẫu của SDK TS/Python/Go pass conformance ở long poll và webhook (Phase 15); bot không gửi được cho người chưa bắt đầu chat với bot (Phase 8).
- [ ] Gõ không dấu tìm được tin có dấu; rời chat, bị kick hoặc tin bị xoá thì không còn tìm được ở cả server lẫn local (Phase 5, 7).
- [ ] Grafana, Alertmanager, GitLab (qua Mattermost), Uptime Kuma, Jenkins đẩy được thông báo vào chat không cần plugin riêng (Phase 9).
- [ ] Failover Postgres không làm mất tin đã ack, từ khi lên cụm riêng; trên `.65` khôi phục PITR mất tối đa khoảng WAL chưa archive (Phase 2, 13, 14).
- [ ] Đổi tên sản phẩm chỉ bằng `brand.config.json` + build lại (Phase 1, 10, 11).
- [ ] Đăng nhập web, mobile và desktop qua `hoandat-auth`; đăng xuất hoặc thu hồi ở `/account` của IdP thì phiên chat bị thu hồi (web ≤ 1 s); IdP sập không làm gián đoạn phiên đang có (Phase 2, 3, 14).
- [ ] Tenant `inetdev.io.vn` chạy ở `chat.inetdev.io.vn`, không thấy dữ liệu của `hoandat.com` qua bất kỳ API nào (Phase 12, 13).

## Non-goals (v1)

Secret chat E2E (đã chừa chỗ trong data model), cuộc gọi thoại/video, stories, payments, games trong bot, tương thích client hoặc Bot API của Telegram, đăng ký bằng số điện thoại, đăng ký/mật khẩu/OTP/2FA riêng trong app chat (thuộc IdP), chat xuyên tenant, callback trạng thái giao cho bên gửi thông báo, format webhook Discord (v1.1).

## Dependencies

- Phụ thuộc IdP `hoandat-auth` (`https://auth.hoandat.com`): các thay đổi trong bảng "Thay đổi cần làm ở `hoandat-auth`" phải có ở staging của IdP trước khi Phase 2 tích hợp đăng nhập thật; trước đó Phase 2 test với IdP chạy local. Không phụ thuộc plan nào khác trong repo này.
- Phase 13 cần quyền triển khai trên server dùng chung `.65` (giai đoạn 1), hạ tầng datacenter Việt Nam cho cụm riêng (giai đoạn 2), và tài khoản Apple Developer, Google Play, FCM.

## Red Team Review

### Session — 2026-10-13
**Findings:** 40 thô từ 4 reviewer (Security, Failure Mode, Assumption, Scope/Contract), gộp còn 15 (15 accepted, 0 rejected; 3 gợi ý cắt phạm vi chuyển thành câu hỏi cho user)
**Severity breakdown:** 7 Critical, 7 High, 1 High/Medium gộp

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Failover Postgres làm pts/seq chạy lùi | Critical | Accept | Phase 1, 2, 13, 14 |
| 2 | Outbox dùng chung không cursor, mất thứ tự, thiếu kind, không retention | Critical | Accept | Phase 1, 2, 3, 7, 8 |
| 3 | Fan-out deadlock, bot thành hot row, unique trên bảng partition | Critical | Accept | Phase 2, 8 |
| 4 | Luồng chat large đứt (kênh, chuyển mode, push, badge) | Critical | Accept | Phase 1, 2, 3, 14 |
| 5 | Worker không dùng được với plugin native | Critical | Accept | Phase 1, 5, 10, 11 |
| 6 | Bot/bulk thành công cụ spam (thiếu consent) | Critical | Accept | Phase 2, 8, 9, 12 |
| 7 | Lưu phiên web chưa chốt (CSRF/CSWSH/XSS), revoke không cắt WS | Critical | Accept | Phase 1, 2, 3, 5 |
| 8 | Contract lệch giữa phase (bulk path, message_id, proto, ratelimit, tên) | High | Accept | Phase 1, 2, 8, 9, 13 |
| 9 | Bot API phơi tính năng core không có | High | Accept | Phase 1, 2 |
| 10 | Mini App: khoá, origin, sandbox, native IPC | High | Accept | Phase 8, 10, 11, 12 |
| 11 | SSRF guard sơ sài | High | Accept | Phase 8, 9, 13 |
| 12 | Media ACL, CDN, EXIF, worker sandbox | High | Accept | Phase 4, 13 |
| 13 | Search ACL/local purge/phân trang/xếp hạng dấu | High | Accept | Phase 2, 5, 7 |
| 14 | Bảo mật xuyên suốt (OTP, dò tìm, push ND13, secret log, OTA, link scheme) | High | Accept | Phase 2, 3, 6, 9, 10, 11, 12 |
| 15 | Delivery bot/webhook, push nền iOS/desktop, GitLab qua Mattermost, spec fold | High/Medium | Accept | Phase 1, 3, 8, 9, 10, 11 |

### Whole-Plan Consistency Sweep
- Đã grep toàn bộ phase cho thuật ngữ cũ: số điện thoại/SMS (đăng ký), `/ext/sendBulk`, `message_id`, tenant token, `sendMessage` Telegram, supergroup, bot hệ thống, Deno/Bun, callback trạng thái, `notify_deliveries`, "tổ chức", "Phase 12 quyết định", `file_unique_id`, `chats.kind`, file proto rời. Không còn mâu thuẫn; các lần xuất hiện còn lại là câu phủ định có chủ đích.
- Phụ thuộc đã cập nhật: Phase 13 `[1, 2]`, Phase 14 thêm 15, Phase 15 `[8]`.

## Validation Log

### Session 1 — 2026-10-13
- Áp dụng cả 15 finding red-team.
- Bot v1: Developer Console + SDK TS (Node), Python, Go; tách 8a (Phase 8) / 8b (Phase 15); không có bot hệ thống quản lý bot.
- Thông báo: chỉ trả accepted `{chat_id, seq}` + bộ đếm tổng hợp; không callback, không trạng thái theo từng người nhận.
- Đăng ký tài khoản: **chỉ email** (OTP email + 2FA tuỳ chọn); bỏ số điện thoại. *(Đã thay ở Session 2: đăng nhập qua `hoandat-auth`.)*
- Quyết định kỹ thuật tự chốt (user có thể bác): RPO = 0 cho tin nhắn (replica đồng bộ quorum + `server_epoch`); update log giữ 30 ngày; thành viên mới mặc định xem được lịch sử, admin group được tắt.

### Session 2 — 2026-10-14
- User xác định: app chat là sản phẩm app tiếp theo trong hệ sinh thái hoandat, dùng IdP `hoandat-auth`. Đã thêm mục [Hệ sinh thái hoandat](#hệ-sinh-thái-hoandat) và phụ thuộc vào IdP.
- Thay quyết định "đăng ký chỉ email (OTP email + 2FA)" của Session 1: đăng nhập chỉ qua `hoandat-auth` (Google/GitHub), bỏ OTP, 2FA và SMTP khỏi app chat.
- Domain production: `chat.hoandat.com`. Tenant theo domain có ngay từ v1 (`chat.<d>`).
- Quyết định kỹ thuật tự chốt (user có thể bác): phiên chat riêng gắn grant IdP thay vì dùng thẳng token IdP; native dùng grant theo thiết bị không trần 90 ngày (cần IdP hỗ trợ); Mini App và media trên domain đăng ký riêng để không same-site với `chat.<d>`; username chat mặc định lấy `preferred_username` của IdP.
- Đã sửa các Phase 1–15 bị ảnh hưởng; mỗi phase sửa có ghi chú `Updated: Validation Session 2`.

### Whole-Plan Consistency Sweep — Session 2
- Grep toàn bộ phase cho: OTP, 2FA, `email_codes`, `RequestEmailCode`, SMTP, CAPTCHA đăng ký, "đăng ký chỉ email", `{{web_domain}}`, `*.{{miniapp_domain}}`, TTL 180 ngày. Không còn mâu thuẫn; lần xuất hiện còn lại là câu phủ định có chủ đích hoặc ghi chú lịch sử.

### Session 3 — 2026-10-14
- Cho phép thay đổi ở repo `hoandat-auth`; plan phía IdP: `hoandat-auth/plans/dattqh/261014-1131-chat-app-integration/`. Quyết định chi tiết từ plan đó áp ngược vào đây: refresh token native theo chính sách client (không `offline_access`), gọi `/token` qua loopback, chat bật theo từng tenant.
- Backend chat chạy chung server `103.72.98.65` với IdP: API nội bộ của IdP gọi qua loopback, bỏ yêu cầu kênh WireGuard/mTLS ở giai đoạn đầu.
- Hạ tầng hai giai đoạn (user chọn hướng A): `.65` cho staging và bản ra mắt đầu; chuyển lên cụm riêng khi chạm ngưỡng RAM/kết nối/latency. RPO = 0 và quy mô 100k chỉ cam kết ở cụm riêng; khi chuyển, API nội bộ IdP cần kênh từ xa. Đã sửa Phase 13, 14 và Success Criteria.

### Session 4 — 2026-10-14
- Dùng REA kiểm kê tĩnh Telegram Desktop 7.3.1 (macOS arm64, Mach-O Evidence `ev_e92380557ae0528ec07cd7d6022ea5722597548aa92f473b3c5d07e2315c1135` và chuỗi trong binary). Không decompile vì auto-analysis của Ghidra trên binary 254MB quá nặng cho máy dùng chung.
- Áp các đề xuất "nên thêm" của báo cáo vào Phase 1 (`config.GetAppConfig`), 2, 4, 5, 7, 8, 11. Giữ nguyên gap timer 150 ms và FTS5 local, vì binary không lộ hằng số của Telegram, và Telegram Desktop chỉ tìm ở server do không lưu tin local.

### Session 5 — 2026-10-14
- Bắt đầu Phase 1 theo đề xuất của Jev (0.79). Đã xong contract, ADR 0001–0010, helper TS/Go, brand, Compose và CI; chi tiết ở mục "Kết quả" của Phase 1.
- Jev quyết bốn điểm phát sinh: giữ protobuf-es và đổi `bigint` sang `number` ở core; outbox giữ 30 ngày; IdP đọc redirect mobile từ biến môi trường; RPC còn thiếu thêm ở phase sở hữu.

### Session 6 — 2026-10-14
- User yêu cầu có mock UI HTML để xem giao diện trước khi code UI. Đã tạo bộ mock [`mockups/index.html`](./mockups/index.html) (ban đầu là một trang, sau mở rộng thành 11 trang, 86 màn hình theo yêu cầu "đủ mọi tính năng trong plan"), dùng token của hệ sinh thái (slate + violet, Inter) như Localman và trang đăng nhập hoandat. Phase 6 chỉ bắt đầu code UI sau khi user duyệt mock.
- Review độc lập Phase 1 ra 15 điểm; đã sửa toàn bộ trong phạm vi Phase 1 (CI, tokenizer tìm kiếm, contract proto, Compose, allowlist URL, Snowflake). Việc thuộc phase sau được ghi vào Phase 2 và 4.

### Session 7 — 2026-10-14
Jev (`jev-1.13.0`) quyết bảy câu hỏi phát sinh khi làm mock; đã áp vào mock và Phase 8, 9, 12:
- Xoay secret webhook: URL cũ chạy thêm 7 ngày (0.93).
- Kết nối song song của webhook bot: 1–100, mặc định 40 như Telegram (0.67; độ tin thấp, đo lại ở load test).
- Admin khác nhận lại webhook đã tự tắt: giữ nguyên URL (0.93). Người cũ vẫn giữ URL, nên màn nhận lại có tuỳ chọn xoay secret, mặc định tắt.
- Chỉ đội vận hành hoandat cấp hoặc thu hồi xác minh bot (0.85).
- Tự xoá tài khoản khi không dùng: mặc định tắt, người dùng tự bật (0.62).
- Bản xuất dữ liệu: giữ 30 ngày, mỗi 7 ngày một lần (0.42, gần ngang phương án 7 ngày/24 giờ 0.41).
- Media và Mini App nằm trên hai domain đăng ký riêng biệt (0.65); tên domain thật vẫn chờ user.

### Session 8 — 2026-10-14
- User quyết định: Media và Mini App chưa cần làm ngay, để sau cùng. Phase 4 (Media) chuyển xuống cuối; mọi phần Mini App đang rải ở Phase 1, 8, 10, 11, 12, 13, 15 được gom về Phase 16 mới. Cả hai làm ngay trước Phase 14.
- Hệ quả: Phase 6 và 8 bỏ phụ thuộc Phase 4; trước khi có Phase 4, app chỉ có tin chữ (composer không có nút đính kèm, Bot API trả "chưa hỗ trợ" cho method file). Tên domain đăng ký riêng cho media và Mini App chọn khi làm Phase 4 và 16.

### Session 9 — 2026-10-14
- User xem lại và quyết: Media và Mini App vẫn làm như kế hoạch, không dời xuống cuối (thay Session 8). Phase 4 và 16 trở về thứ tự bình thường: media lên prod ở R3, Mini App web ở R6; file của Bot API trả về Phase 8. Phase 16 giữ làm phase riêng để Mini App lên prod thành một lát trọn vẹn.
- User muốn review từng giai đoạn trên prod và có người dùng thật; cho phép deploy prod liên tục trong giai đoạn thiết kế và đưa lên prod. Đã thêm mục "Lộ trình phát hành liên tục" (R0–R9). Phase 13 chuyển sang tự deploy prod từ `main` kèm smoke test, tự rollback, feature flag, migration expand/contract. Phase 14 thành smoke test sau mỗi release và cổng mở công khai ở R9.

### Session 10 — 2026-10-14
- User: các sản phẩm (chat-next, hoandat-auth) đều mới, chưa có người dùng, nên tập trung code và push thẳng `main`, không rẽ nhánh. Đã merge `feat/chat-app-clients` vào `main` của `hoandat-auth` và push (`4a9ca7d`); deploy IdP lên prod là một phần của R0.
- Repo `chat-next` đặt trên GitHub private `achoo254/chat-next`, giống `localman-next`; CI chuyển từ GitLab sang GitHub Actions (`.github/workflows/ci.yml`).

### Session 11 — 2026-10-14
- User gửi ảnh Telegram Desktop làm tham khảo: nhóm có topic, cột thư mục, panel thông tin bên phải, tin cảnh báo có khối code kèm nút copy, thẻ xem trước link. Mock được bổ sung theo các mẫu này, nhưng chỉ lấy mẫu bố cục: không dùng logo, icon, hình ảnh, câu chữ của Telegram hay tên thật trong ảnh.
- User đổi cách làm: đề xuất và quyết định phạm vi gửi Jev quyết rồi làm luôn; code UI bám theo mock, có chỉnh sửa thì sửa mock trước rồi mới code; bỏ bước chờ user duyệt mock cho từng release.
- Jev (`jev-1.13.0`) quyết:
  - Topic làm ở R1: 0.48 (R2 0.40, để sau R5 0.12; độ tin 0.22).
  - Mô hình topic là thuộc tính trong luồng tin của nhóm: 0.77 (mỗi topic là một chat riêng 0.23). Mỗi tin mang `topic_id` trong seq của nhóm; sync và difference vẫn theo chat; vị trí đã đọc và số chưa đọc theo (user, chat, topic); topic "Chung" có sẵn; admin đóng hoặc ẩn được topic; link topic chỉ dùng được với thành viên.
  - Phase 2 thêm proto và schema cho topic. Phase 5 giữ schema local sẵn chỗ cho `topic_id`. Phase 6 dựng danh sách topic và khung chat theo topic theo mock.
- Mock bổ sung theo ảnh tham khảo: 6 màn mới và màn `chat.html#app` được sửa, nâng tổng số lên 92 màn; render-check 0 lỗi ở cả hai theme. Jev quyết thêm ba điểm, mock được sửa theo trước khi code:
  - Xem trước link: R1 chỉ có chữ, server lấy trang và chặn SSRF (Phase 2); ảnh thumbnail làm ở R3 (Phase 4). Xác suất 0.98.
  - Thư mục: R1 có bộ lọc sẵn (Tất cả, Cá nhân, Nhóm, Bot), lọc phía client; thư mục tự tạo, đồng bộ giữa thiết bị làm sau R4. Xác suất 0.97.
  - Tin trong topic bị ẩn vẫn tìm được; ẩn chỉ bỏ topic khỏi danh sách (Phase 7). Xác suất 0.99.
- Phase 5 phần web cho R1 đã xong (commit `25f47a2`): core 671 test, platform-web 9 test, có test hỗn loạn, purge khi bị kick, đổi epoch và hai tab. Driver OPFS và Web Locks chưa chạy thử trên trình duyệt thật. Jev quyết ba câu hỏi agent để lại:
  - Thêm `chat_pts` vào `UpdateRead` cho chat large và bỏ bước client đối chiếu unread: 1.00.
  - Thêm RPC `GetPeerDialogs`: 0.98.
  - WebSocket cùng origin tại `wss://chat.hoandat.com/ws`, nginx proxy sang gateway: 0.96.
- Bỏ tab "Chưa đọc" khỏi mock; R1 chỉ có bốn bộ lọc đã chốt. Xác suất 0.86 (giữ làm bộ lọc thứ năm 0.14).
- Backend R1 lên prod (commit `848354e`, migration 0003). Jev giữ mặc định "Ai thêm tôi vào nhóm" là Danh bạ: 0.74.
- Review bảo mật backend R1 tìm ra 4 lỗi High (lộ tin trước `visible_from_seq`, socket còn sống sau khi phiên bị thu hồi, mặc định Danh bạ vô hiệu, thành viên bị kick vào lại qua link mời), 10 Medium và 7 Low. Jev quyết:
  - Danh bạ là danh sách tường minh do người dùng tự thêm; có chung chat không còn được tính. Xác suất 0.77 (giữ định nghĩa nhóm và chat riêng đã trả lời 0.22).
  - Kick là cấm: chặn vào lại qua mọi link cho tới khi admin gỡ cấm, và thu hồi link mời do người bị kick tạo. Xác suất 0.96.
  - Chủ channel hoặc nhóm chỉ chuyển quyền cho admin; chưa có admin thì không được rời. Xác suất 0.83.
  - Mock cập nhật các màn danh bạ, danh sách bị cấm, hộp thoại rời chat trước, sau đó mới sửa backend và UI.
- Việc vận hành còn mở: cổng 443 của server `.65` đang mở cho mọi IP. Bộ lấy trang để xem trước link vì vậy có thể làm lộ IP gốc sau Cloudflare. Muốn giới hạn 443 cho dải Cloudflare thì phải đổi tường lửa chung của server, ảnh hưởng mọi app.
- Giao diện web R1 lên prod sau cờ `VITE_FEATURE_MESSAGING`, mặc định tắt (commit `74f30fc`). Bật cờ khi đủ hai điều kiện: CSP cho phép worker SQLite (wasm) và các lỗi High của review đã được sửa.
- Mock lên 105 màn, gồm danh bạ, danh sách bị cấm, chủ nhóm rời đi, thanh trả lời và sửa, bảng emoji, xác nhận mở link ngoài, màn hẹp. Jev quyết thêm:
  - Xoá thành viên: hành động chính là "Xoá và cấm vào lại", hành động phụ là "Chỉ xoá" (người đó vẫn vào lại được bằng link). Xác suất 0.86.
  - Người nhận chỉ cho Danh bạ nhắn tin: tắt "Gửi link mời" và đưa thêm "Sao chép link". Xác suất 0.97.
- Các bản sửa sau review (commit `ba0badc`, migration 0004) và CSP cho worker SQLite đã lên prod. UI đã nối danh bạ, xoá có cấm hoặc chỉ xoá, danh sách bị cấm, chủ nhóm rời đi, cùng các màn mock mới.
- Jev quyết cách bật nhắn tin (0.99): bản build vẫn tắt cờ; user tự bật trong trình duyệt của mình bằng `localStorage["feature:messaging"]="1"`. Khi chạy ổn trên trình duyệt thật thì bật cờ khi build cho mọi người.
- Còn thiếu so với mock, chờ server bổ sung: chọn admin nhận quyền chủ, RPC xoá chat, tên nhóm trên màn bị cấm, lý do không thêm được của từng người, kiểm quyền riêng tư trước khi tạo nhóm, ngày thêm liên hệ, số nhóm chung; RPC tắt tiếng, ghim chat, danh sách người thả reaction, danh sách đã chặn, hàng đợi kiểm duyệt.
- User quyết (2026-10-14): bỏ cờ nhắn tin, mặc định hiện luôn vì sản phẩm mới chưa có người dùng. Đã xoá cờ `VITE_FEATURE_MESSAGING`, cơ chế ghi đè bằng localStorage và trang chủ R0. Sau khi đăng nhập, app mở thẳng danh sách chat.

### Trạng thái 2026-10-14 23:30
- R1 đang chạy trên https://chat.hoandat.com (release `20261014-162220-549219c690e3`). Đã thử thật trên Windows Edge (zoom 150%) và iPhone. Gồm:
  - nhắn tin chữ realtime;
  - nhóm, nhóm có topic, kênh;
  - trả lời, sửa, xoá, reaction, đã đọc, ghim;
  - link mời `/join/`, danh bạ tường minh, cấm thành viên, chặn, báo cáo;
  - xem trước link chỉ có chữ.
- Đã sửa theo phản hồi khi thử trên prod:
  - bỏ cờ tính năng;
  - kênh không còn bị gọi là nhóm;
  - link mời mở đúng;
  - không còn cuộn ngang trên desktop và mobile;
  - ẩn hẳn các chức năng chưa có, không để nút mờ.
- R1 còn thiếu vì chưa có RPC:
  - tắt tiếng, ghim chat;
  - danh sách người thả reaction, danh sách người đã chặn, hàng đợi kiểm duyệt;
  - xoá chat, chọn admin nhận quyền chủ;
  - lý do không thêm được của từng người, ngày thêm liên hệ, số nhóm chung.
- R1 còn thiếu về kỹ thuật:
  - React Compiler và perf gate CI (Phase 6);
  - test hot user và failover (Phase 2);
  - quay lại trang cũ sau đăng nhập khi đăng nhập ở tab khác (server luôn chuyển về `/`).
- Tiếp theo: làm nốt các RPC còn thiếu của R1 và nối vào UI theo mock, rồi sang R2 (incoming webhook).

### Session 12 — 2026-10-15
- Phân tích tĩnh bằng REA Telegram Desktop 7.3.1 và Zalo 26.10.11, kết quả ở [báo cáo](../reports/rea-261014-2340-chat-ui-ux-telegram-zalo.md). Jev quyết chọn chuẩn tham khảo:
  - Telegram là chuẩn chính: 0.94.
  - Có lấy thêm mẫu từ Zalo: 0.78. Discord: 0.41, không lấy.
- Jev quyết cách kết hợp: theo từng vùng màn hình, 0.96.
  - Telegram cho bố cục, tốc độ, bàn phím, thư mục, topic, kênh.
  - Zalo cho thuật ngữ tiếng Việt, danh bạ, tạo nhóm, thứ tự panel thông tin, chữ trạng thái.
- Jev quyết từng điểm:
  - Vai trò nhóm "Trưởng nhóm / Phó nhóm": 0.97; kênh giữ "Chủ kênh / Admin".
  - Chính tả giữ kiểu "Huỷ, Xoá": 0.88.
  - Tạo nhóm một màn, tên không bắt buộc: 1.00.
  - Thao tác khi rê chuột lên tin và bấm đúp để trả lời: 0.92.
  - Bộ lọc "Chưa đọc": 0.76. Thay quyết định bỏ trước đây, vì có bằng chứng mới là cả hai app đều có.
  - Chữ trạng thái kiểu Zalo: 0.74.
  - Danh sách phím tắt: 0.71.
  - Panel thông tin theo thứ tự Zalo: 0.68.
  - Tìm kiếm chia nhóm kết quả, mở bằng Ctrl/⌘+F: 0.57.
  - Nút "@" nhảy tới tin nhắc tên: 0.52.
  - Áp toàn bộ 7 mục P1 và 4 mục P3 của báo cáo (thu hồi, xoá ở phía tôi, tắt thông báo, đã xem, biểu cảm…).
- Backend R1 phần còn lại lên prod (commit `79c0ca9`, migration 0005):
  - tắt thông báo có thời hạn, ghim chat;
  - danh sách người thả cảm xúc, danh sách đã chặn;
  - xoá chat, chọn admin nhận quyền chủ;
  - lý do không thêm được từng người;
  - hàng đợi kiểm duyệt cho operator (`CHAT_OPERATOR_USER_IDS`);
  - quay lại đúng trang sau khi đăng nhập.
- Việc tiếp theo: sửa mock theo các quyết định trên, sau đó code UI theo mock.
- Mock cập nhật theo hướng kết hợp, tổng cộng 109 màn; render-check 12 trang, sáng và tối, 0 lỗi. Jev quyết thêm:
  - Bộ lọc "Chưa đọc" đứng cuối, sau "Bot": 0.69.
  - Xoá nhóm phải gõ tên nhóm để xác nhận: 0.82.
- Lý do `TOO_MANY` khi thêm thành viên nghĩa là nhóm đã đủ số thành viên tối đa.
- React Compiler để tắt (Jev 1.00): chỉ bật khi đã chuyển các chỗ đọc store lúc render sang hook theo id, JS khởi động vẫn ≤ 150 KiB và test xanh.
- Perf gate `web-perf` chạy trong CI (commit `3814849`). Trên runner GitHub: mở chat từ cache p50 38 ms, p99 78 ms; cuộn 60 fps.
- Giao diện mới theo mock lên prod (commit `7a8f061`, release `20261014-202424-7a8f061e4b5c`).
  - Kiểm tra: 124 test web; perf gate JS khởi động 148,5/150 KiB, mở chat từ cache p50 18 ms, p99 36 ms; render-check 174 lượt, 0 lỗi.
  - Chỗ đọc store lúc render đã chuyển sang hook theo id. Bật React Compiler thì test đều qua nhưng JS khởi động lên 166,8 KiB, nên compiler vẫn tắt.
- Còn lệch so với mock vì thiếu backend hoặc core:
  - danh sách nhiều tin ghim;
  - dòng "Tin nhắn đã thu hồi" trong luồng tin;
  - avatar người thả cảm xúc trên chip;
  - đồng bộ "Đánh dấu chưa đọc" giữa các máy;
  - cài đặt thông báo theo loại chat, âm báo, có tính chat tắt thông báo vào badge không;
  - kiểm duyệt nâng cao;
  - số thành viên đang hoạt động cho nhóm trên 50 người;
  - fake server của core lỗi khi đẩy `pinned_dialogs`/`chat_deleted`.
- Bù backend, core và UI so với mock, lên prod (commit `925d317`, migration 0006):
  - nhiều tin ghim, dòng "Tin nhắn đã thu hồi";
  - avatar người thả cảm xúc;
  - "Đánh dấu chưa đọc" đồng bộ;
  - cài đặt thông báo theo loại chat, áp cho badge và thông báo trình duyệt;
  - số đang hoạt động lấy từ server.
  - Kiểm tra: 698 test core, 141 test web, 14 test platform-web; JS khởi động 148/150 KiB.
- R1 coi như xong phần nhắn tin. Còn lại cho R9: kiểm duyệt nâng cao, tenant theo Host. Tiếp theo: R2, incoming webhook (Phase 9).
- Jev quyết đặt incoming webhook tại `https://chat.<d>/hook/{id}/{secret}` trên host chat đang được Cloudflare proxy (0.72). Phương án `hook.chat.<d>` không proxy được 0.27. Lý do: SSL Universal miễn phí của Cloudflare chỉ phủ `*.hoandat.com`, nên host hai cấp được proxy sẽ lỗi TLS. `bot.chat.<d>` của R5 gặp cùng vấn đề, sẽ quyết khi làm R5.
- Jev quyết ngưỡng mở chat riêng cho CI (0.98): trên runner GitHub dùng chung, p50 ≤ 75 ms và p99 ≤ 200 ms, khoảng gấp đôi ngưỡng laptop. Ngưỡng của plan (p50 ≤ 50 ms, p99 ≤ 100 ms) vẫn áp cho `pnpm perf` trên máy dev và cho kiểm tra trước phát hành. Lý do: cùng một code, máy dev đo ổn định 18/38 ms, còn CI dao động p99 từ 78 đến 142 ms, kể cả commit chỉ sửa tài liệu cũng đỏ.
- R2 lên prod.
  - Backend: commit `cf3646f`, migration 0007, webhook tại `chat.<d>/hook/…`.
  - UI quản lý webhook và hiển thị tin cảnh báo: commit `cb35969`, 165 test web; JS khởi động 149,1/150 KiB.
- R2 còn thiếu:
  - tin hệ thống khi webhook tự tắt;
  - trường `silent` ở core để UI hiện chuông gạch và không phát âm báo;
  - RPC sửa tên, `allow_alert`, `silent` sau khi tạo hook;
  - ảnh webhook (cần media R3);
  - fake server của core lỗi với `from_id 0`.
- Ngân sách JS khởi động gần hết: cần tách bớt (protobuf trong entry, Settings) trước khi thêm tính năng ở màn đầu.
- Bù xong R2 (commit `85ac913` và `b581817`, migration 0008):
  - tin hệ thống khi webhook dừng, sửa cài đặt hook, chuông gạch cho tin im lặng;
  - JS khởi động từ 149,1 xuống 112,5 KiB; React Compiler bật mặc định, JS khởi động 130,7/150 KiB.
- Việc mock còn thiếu: màn sửa webhook (UI đang dùng lại các trường của `#create-hook`).
- Tiếp theo: R3 media (Phase 4).
- R3, Jev quyết:
  - Lưu trữ dùng iNET Object Storage (S3, Ceph RGW): 0.70. MinIO trên `.65`: 0.27.
  - Media tạm phục vụ từ `media-chat.hoandat.com` qua Cloudflare; chuyển sang domain đăng ký riêng trước R9: 0.92.
  - Hiện chưa có gói storage dùng được cho prod: gói test 1 GB còn hạn, gói PRO 100 GB đã hết hạn 03/09/2026. Mua hoặc gia hạn gói cần user quyết.
  - Code R3 viết theo S3 chung, cấu hình qua env, nên không phải chờ gói.
- User chọn tạm dùng gói test 1 GB (dịch vụ `dattqh-test`, OneDash hệ nb) cho R3.
  - Bucket `chat-media`, danh tính `chat-api`, quyền `write` (Get, List, Put, Delete, AbortMultipartUpload); endpoint `drive-storagehns3st.000nethost.com`, region `hn-storage`, path-style.
  - Khoá S3 chỉ phát trên web OneDash. User đưa vào `$ACCESS_TOKENS_JSON` với mục `chat-media-s3`, tôi ghi vào `/opt/chat/.env` mà không in giá trị.
- DNS `media-chat.hoandat.com` (proxied) và chứng chỉ Let's Encrypt đã tạo bằng `infra/chat/ensure-dns.sh` và `issue-cert.sh`.
- User đổi quyết định (2026-10-15): media lưu ngay trên server `.65`, không dùng iNET Object Storage. Thay cho các mục về gói test và khoá S3 ở trên. Jev quyết:
  - Driver lưu trên filesystem, thư mục `/opt/chat/media`: 0.99. Upload chia khúc qua API; tải xuống do app phục vụ có Range tại `media-chat.hoandat.com`. Driver S3 giữ lại trong code để chuyển lên cụm riêng sau này.
  - Backup media mỗi đêm ra ngoài server, cùng lúc với dump DB: 1.00. Nơi nhận backup chưa chọn, script tắt cho tới khi đặt đích.
  - Có ngưỡng đĩa trống tối thiểu: hết chỗ thì từ chối upload, để không làm đầy đĩa của server dùng chung.
- Bucket `chat-media` và danh tính `chat-api` trên OneDash không còn dùng. MCP không có tool xoá; user xoá trên web nếu muốn.
- User quyết (2026-10-15): chưa làm backup ra ngoài server. `.65` là nơi lưu trung tâm cho mọi thứ (DB, media) tới khi có người dùng thật; lúc đó mới thiết kế lưu trữ và backup bên ngoài. Thay cho quyết định backup media mỗi đêm ở trên.
- Thanh cuộn ngang trong khung tin: hàng nút hiện khi rê chuột lên tin của mình bung sang phải, vượt mép danh sách. Đã sửa: bung về phía còn trống (commit `e1c186d`).
- Phản hồi của user: chip cảm xúc trông cồng kềnh so với Zalo và Telegram. Jev quyết:
  - Vị trí kiểu Zalo, chip nổi đè lên mép dưới bong bóng: 0.53. Kiểu Telegram, cùng hàng với giờ gửi: 0.47, sát ngưỡng. Giữ hàng riêng như hiện tại: 0.
  - Avatar trong chip chỉ hiện ở chat riêng và nhóm từ 10 người trở xuống; nhóm lớn hơn hiện emoji kèm số: 0.83.
  - Sửa mock trước, rồi code UI.
- Mock chip cảm xúc kiểu Zalo đã xong. Jev quyết thêm:
  - Tách ngưỡng 10 người cho avatar trên chip khỏi ngưỡng danh sách "ai đã thả, ai đã xem" của server: 0.99.
  - Hơn 3 người thả cùng một emoji thì hiện 3 avatar kèm "+N": 0.58, sát ngưỡng.

- Phát triển một mình và người dùng chưa có bạn (2026-10-15). User hỏi: chỉ có một người phát triển thì test tính năng nhiều người thế nào, và người dùng thật chưa có bạn thì chat với ai. User đồng ý làm theo các phương án Jev đánh giá cao:
  - Hướng tăng trưởng: kéo cả nhóm vào cùng lúc qua tenant theo domain, link mời nhóm và cảnh báo webhook: 0.96. Làm app dùng được một mình 0.04; tìm người và vòng mời bạn 0.00.
  - Test một mình: trước tiên làm E2E Playwright nhiều trình duyệt trên stack local với người dùng thử: 0.64 (tài khoản Google/GitHub phụ test tay 0.28, người dùng ảo trên prod 0.08). Đăng nhập dev bỏ qua IdP chấp nhận được nếu chỉ có ở bản build local: 0.72. Làm E2E trước R3b: 0.65.
  - Chat với chính mình, làm trước R5: 0.66. Tên "Cloud của tôi" theo Zalo: 0.78. Luôn có sẵn và ghim đầu danh sách: 0.76. Làm ngay, song song với R3: 0.45 (sau R3 0.31; độ tin thấp).
  - Nút trên màn trống mở luồng tạo nhóm rồi đưa link mời của nhóm: 0.96; link cá nhân và QR 0.00.
  - Bot chính thức chào người dùng mới ở R5: 0.68.
  - Kênh công khai của sản phẩm gợi ý cho người mới: 0.41, chưa làm.
  - Đã thêm release R3b vào lộ trình, mục todo vào Phase 2, 6, 8, 14 và màn `chat.html#first-run` (mock 110 màn).
- R3 lên prod (2026-10-15).
  - Backend media: commit `8239fd0`, migration 0009, lưu ở `/opt/chat/media`, host `media-chat.hoandat.com`.
  - UI media và chip cảm xúc kiểu Zalo: commit `0b19d79`, 207 test web, JS khởi động 136,6/150 KiB, render-check 84 lượt 0 lỗi.
- R3 còn thiếu:
  - tạm dừng upload;
  - `topicId` cho tin đang gửi;
  - chỉ mục media theo chat (hiện chỉ quét 600 tin gần nhất);
  - giữ `grouped_id` khi chuyển tiếp album;
  - poster và waveform phía server (cần ffmpeg trên `.65`);
  - bộ lọc tìm theo loại media (Phase 7).
- Phiên `chat-next-85` làm song song trên cùng thư mục repo (E2E nhiều người dùng, "Cloud của tôi"). E2E của phiên đó bắt được lỗi: tạo chat riêng xong mở `/c/1` báo "Không mở được chat này", client gọi `GetHistory` lặp liên tục. Phiên đó đang điều tra.
- Lỗi chat riêng đã sửa và lên prod (commit `30952bc` của phiên `chat-next-85`).
  - Nguyên nhân: server chưa ghi update cho chat riêng cho tới tin đầu tiên, còn core chỉ đọc DB local.
  - Cách sửa: khi thiếu chat, core gọi `refreshChat` qua `GetPeerDialogs`.
- Ba lỗi E2E còn lại đang được agent của phiên này sửa:
  - người bị xoá khỏi nhóm thấy báo lỗi mạng;
  - Esc không đóng hộp thoại Thành viên;
  - log ERROR "context canceled" khi client tự huỷ request.

- E2E nhiều người dùng lên `main` (`pnpm e2e`, `pnpm e2e --serve`): IdP giả trong `server/cmd/e2e-stack`, không thêm đường đăng nhập nào vào server (Jev 0.69); test đặt ở `apps/web/test/e2e` (0.99); chỉ chạy local trước (0.94). E2E bắt được và đã sửa: tạo chat riêng rồi mở ngay báo "Không mở được chat này" (core chỉ đọc DB local), hộp thoại "Chưa thêm được" ghi "Người dùng" thay vì tên.
- R3b lên prod (commit `e7c9c9c`, `bd14849`, `dd898b1`, migration 0010). Jev quyết: chat với chính mình là chat riêng có hai đầu là một người (0.77); tạo ở `GetSelf` cho cả tài khoản cũ (0.69); không tính vào giới hạn 5 chat ghim (0.99); tạo nhóm từ màn trống dùng hộp thoại thường cho phép không chọn ai (0.63). Nút màn trống rút gọn thành "Tạo nhóm và mời" để không xuống dòng ở cột 280 px. Kiểm tra: Go toàn bộ, core 733, web 207, E2E 15/15. Chi tiết: [R3b](../261015-0949-r3b-first-run/plan.md).
- Tên và email lấy từ userinfo khi đăng nhập và refresh (commit `a753562`). Đã xác nhận trên prod: `achoo254` có tên "Đạt Trịnh Quốc Hoàn" và email `quocdat254@gmail.com` đã xác minh; `trinhquochoandat` có email đã xác minh, tên do user tự đặt được giữ nguyên.
- R4 bắt đầu. Jev quyết tìm kiếm phía server dùng Postgres (1.00), không dùng Meilisearch: cột text đã fold (vifold) có index trong DB chat, ghi cùng transaction với tin; ACL kiểm bằng SQL; re-rank theo dấu ở Go; có interface để thay bằng Meilisearch khi có người dùng thật.
- R4 lên prod (commit `b83b949`, migration 0011).
  - Tìm không dấu phía server bằng Postgres tsvector trên token vifold; khớp theo đầu từ, vì `.65` không có `pg_trgm`.
  - Client gộp kết quả local với kết quả server; panel tìm kiếm chia nhóm; tìm trong chat.
  - Kiểm tra: E2E 16/16, core 751 test, web 223 test, JS khởi động 138,2/150 KiB.
  - Muốn tìm theo chuỗi con thì phải cài `postgresql-16` contrib trên `.65`. Đó là thay đổi máy dùng chung, cần user quyết.
- Tiếp theo theo lộ trình: R5 (bot, Developer Console, SDK).

## Bàn giao (2026-10-15 13:50) — đã cũ, xem mục "Bàn giao (2026-10-16 13:00)" ở cuối

### Đang chạy trên prod (https://chat.hoandat.com, release `20261015-064105-400abbd84883`, commit `400abbd`)
- **R0:** đăng nhập qua `hoandat-auth`. Tên và email lấy từ userinfo, user tự đổi tên thì không bị ghi đè.
- **R1 nhắn tin:**
  - chat 1-1, nhóm, nhóm có topic, kênh;
  - trả lời, sửa, thu hồi, xoá ở phía tôi, chuyển tiếp, cảm xúc kiểu Zalo, đã xem, ghim nhiều tin;
  - link mời `/join/`, danh bạ tường minh, kick là cấm, chặn, báo cáo;
  - tắt thông báo, ghim chat, đánh dấu chưa đọc, cài đặt thông báo;
  - hàng đợi kiểm duyệt cho operator (`CHAT_OPERATOR_USER_IDS` hiện trống).
- **R2:** incoming webhook tại `chat.<d>/hook/{id}/{secret}`, định dạng JSON riêng, Slack, Alertmanager, Grafana, GitLab.
- **R3:** media lưu trên đĩa `.65` tại `/opt/chat/media`, phục vụ qua `media-chat.hoandat.com`.
- **R3b** (phiên `chat-next-85`): "Cloud của tôi", màn trống mời đồng đội.
- **R4:** tìm không dấu theo chuỗi con. Server dùng Postgres `pg_trgm` (migration 0012), máy khách dùng FTS5 trigram.
- **Kiểm tra cuối:** Go 21 package (race), golangci-lint 0 issues; test core 754, web 224, platform-web 17; E2E `pnpm e2e` 16/16; perf gate (JS khởi động 138,2/150 KiB); React Compiler đang bật.

### Cách làm việc đã chốt với user (bộ nhớ dự án lưu đủ)
- Push thẳng `main`, không tạo nhánh. CI xanh thì workflow `deploy` tự deploy prod qua user `chat-deploy`.
  - Đổi `infra/chat/` thì phải rsync lên `/opt/chat/infra` trước khi push; xem `docs/deployment-guide.md`.
- Quyết định kỹ thuật và phạm vi gửi Jev (TypeSafe, key ở `$ACCESS_TOKENS_JSON` mục `api.typesafe.ai`). Thực hiện ngay theo lựa chọn của Jev, báo user kèm xác suất. Mua bán, thay đổi máy dùng chung hoặc cấp quyền dữ liệu thì hỏi user.
- Mock là đặc tả UI: sửa mock trước, code sau. Không dùng feature flag, không hiện nhãn lộ trình hay nút mờ. Không có thanh cuộn ngang; kiểm ở 1333x780 và 390x844.
- Hướng UI: Telegram cho cấu trúc, Zalo cho thuật ngữ tiếng Việt ([báo cáo](../reports/rea-261014-2340-chat-ui-ux-telegram-zalo.md)).
- Mọi thứ lưu trên `.65`, chưa backup ra ngoài cho tới khi có người dùng thật.
- Mọi thay đổi hạ tầng ghi vào `docs/infrastructure-inventory.md` trong cùng commit.
- Gitleaks phải chặn commit; không pipe lệnh kiểm qua `tail`.
- Máy dev 16 GB: mỗi lúc chỉ một job nặng, vitest `--maxWorkers=2`.
- Có thể có phiên Claude khác (`chat-next-*`) làm cùng thư mục. Báo trước khi push, mỗi bên chỉ stage phần của mình, không commit thay đổi của phiên khác.

### Còn mở
- **R3:**
  - tạm dừng upload;
  - giữ `grouped_id` khi chuyển tiếp album;
  - poster video và sóng âm phía server (cần ffmpeg trên `.65`, chưa cài);
  - chỉ mục media theo chat (hiện chỉ quét 600 tin);
  - `topicId` của tin media đang gửi.
- **R1:**
  - cờ "bị cấm" trong `UpdateMemberRemoved`, để tách câu thông báo bị xoá và bị cấm;
  - kiểm duyệt nâng cao: gộp báo cáo, cảnh cáo, nhật ký.
- **Mock:** chưa có màn sửa webhook.
- **Hạ tầng:**
  - cổng 443 của `.65` mở cho mọi IP;
  - SSL Cloudflare của zone nên ở "Full (strict)", chưa kiểm;
  - bucket `chat-media` và danh tính `chat-api` trên OneDash không còn dùng.
- **Phase 13:** chưa có metrics, tracing hay canary.

### Việc tiếp theo
**R5:** bot, Developer Console, SDK TS/Python/Go, thông báo qua bot, bot chào người dùng mới (Phase 8, 15, phần bot của Phase 9).
- Trước khi code: đọc Phase 8 và 15, mock `bots.html` và `console.html`, báo cáo `researcher-261013-1120-telegram-bot-platform.md`.
- Cần quyết host cho Bot API: `bot.chat.<d>` không proxy được qua SSL miễn phí của Cloudflare, cùng vấn đề webhook đã gặp. Gửi Jev, phương án gần nhất là đường dẫn trên `chat.<d>`.


## Tiến độ R5 (2026-10-15 15:35)

Lát A lên prod, release `20261015-083208-4affc40f9568` (commit `4affc40`, deploy bằng root vì đổi nginx `/bot/`):
- Bot API tại `https://chat.<d>/bot/v1/` trong process `chat-api` ([spec](../../../spec/bot-api/openapi.yaml)): `me`, gửi tin chữ (entities hoặc Markdown/HTML), bàn phím trả lời và inline, long poll (409 khi poll trùng), trả lời callback, đặt lệnh, xem chat.
- Consent kiểm ở lõi; update từ consumer outbox riêng, một writer `update_id` mỗi bot.
- Developer Console trong Cài đặt: tạo, sửa, lệnh theo phạm vi, cấp lại token và xoá (cần đăng nhập IdP trong 10 phút).
- Deep link `/b/<username>?start=`, nút Bắt đầu, menu lệnh, bàn phím một lần lưu local.
- Cloud của tôi: xoá toàn bộ tin vẫn giữ Cloud và ghim, ô soạn "Ghi chú vào Cloud của tôi", không có Tắt thông báo, biểu cảm chỉ emoji; danh sách chat có ảnh nhỏ cho tin ảnh/video.

Quyết định của Jev (`jev-1.13.0`): host đường dẫn trên `chat.<d>` (0,92); chạy trong process `api` (1,0); lát đầu Console + long poll (0,67); update từ consumer outbox (0,99); năm sửa màn Cloud (0,59–0,91); ô soạn 390px ẩn emoji khi có bàn phím bot (0,80 làm trước deploy); lưu bàn phím một lần (0,56); menu lệnh bot trong nhóm để sau (0,13).

Còn lại của R5: webhook ra ngoài + `safehttp` + dead-letter + HMAC; file/media, sửa/xoá/chuyển tiếp, quản trị nhóm; bulk; inline mode; menu lệnh trong nhóm; SDK TS/Python/Go + docs; bot chào người dùng mới; kiểm response theo OpenAPI tự động. Kiểm một lần trên prod: "Cấp lại token" (IdP phải trả `auth_time`).

## Tiến độ (2026-10-15 23:15)

Từ 16:43, user giao: AI tự review từng màn hình và tính năng trên Chrome đã đăng nhập, mọi đề xuất gửi Jev quyết, làm tuần tự tới hết plan, ưu tiên app vận hành cơ bản ngay.

Đã lên prod (release cuối `99c2ab5`):
- Logo, favicon, màn chờ có hiệu ứng; một loader trễ 320 ms cho mỗi màn, tải trước màn phụ khi rảnh.
- Sửa sau review trình duyệt và QA nhiều người dùng: bài đăng kênh, phiên đăng nhập lại thay phiên cũ, ngày tương đối, hộp Chat mới mở ngay, username ngắn đệm số, trạng thái mất mạng, service worker (mở offline, tiếp quản ngay, thanh "Đã có bản mới · Tải lại"), nhóm có chủ đề, câu trung tính khi không nhắn được.
- R5: webhook ra ngoài (safehttp, HMAC, dead-letter, cần đăng nhập lại khi đổi webhook, chặn IP của chính server), đủ method Bot API trừ inline và bulk, menu lệnh trong nhóm, test hợp đồng OpenAPI, bot trợ lý `tro_ly_bot` chào người dùng mới và nhận góp ý vào Kiểm duyệt > Góp ý.
- Vận hành: `OUTBOUND_DENY_CIDRS=103.72.98.65`, `CHAT_OPERATOR_USER_IDS=1` (@achoo254, user cho phép).

Đã thử và gỡ: nhường quyền tab chính cho bản mới (khoá OPFS không nhả khi đóng DB; review dựng lại trên Chromium).

Còn lại của R5: gửi hàng loạt + thông báo qua bot + operator báo tính năng mới; inline mode; SDK TS/Python/Go; chỉ báo "đang gõ" (Jev: chưa làm).

Quyết định 2026-10-15 23:20: user chọn PWA + Web Push trước, app native R7 (Capacitor) và R8 (Tauri) làm sau khi có tài khoản Apple Developer, Google Play, Firebase. Jev chọn làm PWA + Web Push trước các mục R9 (0,99).

Web Push đã kiểm trên thiết bị thật ngày 2026-10-16 10:14: Edge trên macOS (dịch vụ push của Microsoft) và PWA trên iPhone (web.push.apple.com) đều hiện thông báo. Apple từ chối header `Topic` của RFC 8030 (`BadWebPushTopic`), nên server bỏ header này khi gửi tới Apple (commit `d3ce914`).

## Bàn giao (2026-10-16 13:00) — đọc mục này trước khi làm tiếp

### Đang chạy trên prod
https://chat.hoandat.com, release `20261016-050911-16edf3a179ca` (commit `16edf3a`, deploy bằng root), migration 19.
- R0–R4 như mục bàn giao cũ; R3b Cloud của tôi (xoá toàn bộ tin vẫn giữ Cloud, ghim).
- R5 bot: Bot API ở `chat.<d>/bot/v1/` trong process `chat-api`; long poll + webhook (safehttp chặn IP nội bộ và IP của .65, HMAC, dead-letter, đổi webhook cần đăng nhập lại); đủ method trừ inline mode và bulk; menu lệnh trong nhóm; Developer Console; bot trợ lý `tro_ly_bot` chào sau "Bắt đầu", góp ý vào Kiểm duyệt > Góp ý.
- PWA cài được + Web Push (đã kiểm Edge macOS và iPhone; Apple không nhận header Topic nên bỏ khi gửi tới Apple).
- Xuất dữ liệu (ZIP JSON + HTML + media, 30 ngày, 1 lần/7 ngày), xoá tài khoản chat (ân hạn 30 ngày, chặn khi còn làm chủ nhóm/kênh, bot dừng), tự xoá khi không dùng 6/12/24 tháng; `docs/privacy/data-inventory.md`.
- Đã sửa sau review trình duyệt: logo, favicon, màn chờ; một loader trễ cho mỗi màn; bài đăng kênh; phiên đăng nhập lại thay phiên cũ; trạng thái mất mạng; service worker tiếp quản ngay + thanh "Đã có bản mới · Tải lại"; badge và thanh "Tin chưa đọc"; nhóm có chủ đề; username ngắn đệm số.
- `.env` prod có thêm: `OUTBOUND_DENY_CIDRS`, `CHAT_OPERATOR_USER_IDS=1` (@achoo254, user cho phép), `WEB_PUSH_VAPID_PRIVATE_KEY` (không bao giờ thay). Ghi ở `docs/infrastructure-inventory.md`.

### Cách làm việc (bộ nhớ dự án có đủ)
- AI tự review từng màn trên Chrome đã đăng nhập của user, mọi đề xuất gửi Jev quyết rồi làm luôn; mock trước, code sau; không cuộn ngang; báo user ngay khi deploy xong để họ test.
- Push thẳng `main`. **CI GitHub Actions đang bị chặn vì thanh toán** (job không chạy: "recent account payments have failed or your spending limit needs to be increased"); push không còn tự deploy. Cho tới khi user sửa billing: chạy đủ gate trên máy dev (lint, typecheck, vitest từng package `--maxWorkers=2`, `pnpm perf`, `pnpm e2e`, `go test -race -p 2 ./...`, golangci-lint, proto, gitleaks) rồi deploy bằng root (`infra/chat/deploy.sh`, cách nạp key ở skill `chat-ops-prod`).
- Agent con chạy model Opus đã chạm giới hạn tuần (mở lại 2026-10-21 07:00); trước đó tự làm trực tiếp hoặc dùng agent model khác.
- Nhiều agent cùng sửa một cây code: commit theo đường dẫn, không `git add -A` khi còn agent đang làm.

### Nợ kỹ thuật cần xử lý sớm
- Ngân sách JS khởi động tạm nâng 155 KB (`apps/web/test/perf/budgets.ts`), hiện 150,6 KB: phải cắt về ≤150 KB ở lượt kế (Jev "raise_then_trim").
- Ba consumer outbox (push, bots, sweeper realtime) lặp logic cursor; gộp lại.
- Nhóm thấy "Tài khoản đã xoá" chỉ khi người đó xuất hiện lại trong update (muốn ngay cần loại update mới).
- `docs/privacy/nd13-assessment.md` (đánh giá chuyển dữ liệu ra nước ngoài) chưa viết.

### Việc tiếp theo (thứ tự Jev đã xếp, độ tin thấp nên có thể hỏi lại)
1. Cắt JS khởi động về ≤150 KB (nợ ở trên).
2. R9: chống lạm dụng đầy đủ (Phase 12), tenant thứ hai `inetdev.io.vn` (cần sửa repo `hoandat-auth`), load test lượt 1.
3. R5 còn lại: gửi hàng loạt + thông báo qua bot + operator báo tính năng mới; inline mode; SDK TS/Python/Go; chỉ báo "đang gõ" (Jev: chưa làm).
4. R6 Mini App web.
5. R7/R8 native khi user có tài khoản Apple Developer, Google Play, Firebase; Android có thể đóng gói PWA bằng Trusted Web Activity.
