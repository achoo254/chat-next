---
phase: 13
title: "Phase 13: Hạ tầng self-host Việt Nam và observability"
status: pending
priority: P1
effort: "L"
dependencies: [1, 2]
principles: [7, 2, 4, 5]
---

# Phase 13: Hạ tầng self-host Việt Nam và observability

<!-- Updated: Red Team 2026-10-13 - Postgres replica đồng bộ (quorum) + server_epoch khi failover/restore, egress NetworkPolicy cho dispatcher/fetcher, Redis/Meili bắt buộc auth, CDN xác thực token tại edge, redact /hook/* ở edge, Capgo self-host -->
<!-- Updated: Validation Session 2 2026-10-14 - kết nối IdP hoandat-auth + API nội bộ, host/chứng chỉ theo tenant, bỏ SMTP OTP, canary IdP -->
<!-- Updated: Validation Session 3 2026-10-14 - hai giai đoạn: giai đoạn 1 trên server dùng chung .65 (cùng IdP, API nội bộ qua loopback), giai đoạn 2 chuyển lên cụm riêng; RPO=0 và quy mô 100k cam kết ở giai đoạn 2 -->
<!-- Updated: Validation Session 8 2026-10-14 - S3/CDN cho media dựng khi làm Phase 4; khoá Mini App ở Phase 16 -->
<!-- Updated: Validation Session 9 2026-10-14 - deploy prod liên tục từ main, smoke test + tự rollback, feature flag, migration expand/contract; prod dựng ở release R0 -->

## Goal

Dựng hạ tầng tại Việt Nam theo hai giai đoạn, có sao lưu và đo đạc đủ để chứng minh các ngân sách latency. Phase này chạy song song với các phase tính năng.

- **Giai đoạn 1 — server dùng chung `103.72.98.65`:** staging và bản ra mắt đầu chạy chung máy với IdP `hoandat-auth`, Localman, Tunelo, theo quy ước của máy đó (pm2, nginx một file mỗi hostname, không Docker Compose). API nội bộ của IdP gọi qua loopback.
- **Giai đoạn 2 — cụm riêng:** khi tải đạt ngưỡng chuyển (mục "Ngưỡng chuyển" dưới), chuyển các role và dữ liệu sang cụm riêng ở datacenter Việt Nam. RPO = 0 và quy mô 100k kết nối chỉ được cam kết ở giai đoạn này.

## Context Links

- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md) — staged architecture, latency
- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — canary, dashboard

## Key Insights

- Đặt server tại Việt Nam là đòn bẩy latency lớn nhất cho người dùng trong nước.
- Mọi role (api, gateway, worker, botapi, webhook) đều stateless, scale ngang độc lập; trạng thái nằm ở Postgres, Redis, Meilisearch, S3. Nhờ vậy chuyển từ giai đoạn 1 sang 2 chỉ là đổi nơi chạy và địa chỉ dịch vụ, không đổi code.
- `.65` là máy dùng chung và từng thiếu RAM; chat sập vì hết RAM có thể kéo theo IdP, Localman, Tunelo. Mỗi process chat phải có trần bộ nhớ, và ngân sách RAM của chat được đo trước khi mở cho người dùng.
- Trên một máy không có replica đồng bộ thật, nên giai đoạn 1 chỉ đạt RPO bằng độ trễ WAL archiving, không phải RPO = 0.
- Đo end-to-end bằng canary từ mạng Viettel, VNPT, FPT, cộng RUM từ client thật.

## Requirements

Chung cho cả hai giai đoạn:
- Host theo tenant (ADR 0010): `chat.<d>` và `*.chat.<d>` cho mỗi tenant, nginx chọn chứng chỉ theo SNI; chứng chỉ của tenant cấp theo hàng đợi provisioner của hệ sinh thái hoandat (IdP bổ sung host `chat.`); tenant bị đình chỉ ở IdP thì edge và API trả `421`.
- Kết nối tới IdP `hoandat-auth`: discovery, token, revocation, userinfo đi qua HTTPS của issuer; API nội bộ của IdP dùng Basic credentials riêng của vai `chat`. Ở giai đoạn 1, token endpoint gọi thẳng qua loopback để dùng hạn mức riêng của IdP; tenant chỉ phục vụ chat sau khi owner bật chat ở `/admin` của IdP và thêm DNS A `chat.<d>`, `*.chat.<d>` (DNS-only).
- TLS (ACME), rate limit ở edge, redact path `/hook/*` và query của `/auth/callback` trong access log, CSP và security header cho web.
- Secret cho khoá APNs/FCM, khoá mã hoá cột, khoá ký OTA, secret `chat-web` của tenant chính, khoá app `chat-web` để suy secret theo tenant, Basic credentials API nội bộ IdP. Không có SMTP vì app không gửi email.
- Observability: Prometheus + Grafana, log tập trung, tracing (OpenTelemetry), RUM từ client (độ trễ mở chat, cold start, gửi→ack).
- Dashboard + cảnh báo theo ngân sách latency (bảng trong `plan.md`), cảnh báo đẩy vào chính sản phẩm qua incoming webhook (Phase 9) và qua kênh dự phòng (email).
- Canary: bot tổng hợp gửi/nhận mỗi phút từ 3 nhà mạng; canary webhook; canary IdP (discovery, JWKS, API nội bộ) để cảnh báo trước khi đăng nhập mới bị ảnh hưởng.
- CI/CD GitHub Actions, deploy prod liên tục (user cho phép ngày 2026-10-14 trong giai đoạn thiết kế và đưa lên prod):
  - Mỗi commit lên `main` qua đủ kiểm tra thì tự deploy prod `chat.hoandat.com`; không có cổng phê duyệt tay.
  - Smoke test tự động trên prod sau mỗi deploy (đăng nhập bằng tài khoản thử, gửi/nhận một tin, `/healthz`); đỏ thì tự rollback về bản trước.
  - Tính năng chưa xong nằm sau feature flag theo tenant/người dùng, để code lên prod sớm mà người dùng thật chỉ thấy khi bật.
  - Migration theo kiểu mở rộng rồi thu hẹp (expand/contract) để bản cũ và mới chạy song song khi deploy; backup Postgres trước mỗi migration.
  - Rollback một lệnh về bản trước.

Giai đoạn 1 (`.65`):
- Mỗi role là một process pm2 có `max_memory_restart`; thư mục `/var/www/chat-next`, cấu hình `.env` mode 600 sinh trên server, không sync từ máy dev.
- API nội bộ IdP gọi thẳng `127.0.0.1:4501`; không mở cổng nào của IdP ra ngoài.
- Postgres 17 một instance trên máy (database và user riêng cho chat), WAL archiving + pgBackRest ra kho ngoài máy, PITR; mỗi lần restore tăng `server_epoch`. Redis có mật khẩu, Meilisearch có API key, chỉ bind `127.0.0.1`. Media lưu S3-compatible ngoài máy (không chiếm đĩa `.65`), dựng trước release R3.
- Dispatcher webhook/bot và fetcher URL không có NetworkPolicy, nên `safehttp` (Phase 8) là lớp chặn mạng nội bộ chính; thêm luật firewall chặn process chat gọi tới dải lab nội bộ.
- Ngân sách RAM: đo RSS từng role dưới tải thử; tổng RSS chat cộng phần đang dùng của máy phải chừa ≥ 30% RAM trống; vượt thì dừng mở rộng người dùng và chuyển giai đoạn 2.

Giai đoạn 2 (cụm riêng):
- Kubernetes (hoặc Nomad nếu đội vận hành quen hơn) với deployment cho từng role.
- Postgres 17 HA (Patroni hoặc CloudNativePG) với **replica đồng bộ theo quorum** (`synchronous_commit=on`, ≥ 2 standby để một standby treo không chặn ghi); mỗi lần failover hoặc PITR tăng `server_epoch` (ADR 0002) bằng hook của công cụ HA/runbook; PgBouncer; backup liên tục (WAL archiving, pgBackRest) + PITR; diễn tập khôi phục.
- Redis HA (Sentinel) bắt buộc ACL/mật khẩu; Meilisearch hai bản (dual-write, Phase 7) bắt buộc API key; S3-compatible (MinIO/Ceph) có replication và lifecycle rule; CDN nội địa xác thực token tại edge cho `{{media_domain}}`; Capgo self-host cho OTA mobile.
- NetworkPolicy: pod dispatcher webhook/bot và fetcher URL chỉ được ra internet, chặn mọi CIDR nội bộ; media worker chỉ được tới S3.
- API nội bộ IdP không còn trên loopback: cần kênh có xác thực (WireGuard hoặc mTLS) tới `.65`, hoặc chuyển IdP cùng sang cụm. Đây là thay đổi phía `hoandat-auth`, lên plan khi bắt đầu giai đoạn 2.
- Chuyển dữ liệu: backup trước, chặn ghi ngắn, restore Postgres sang cụm, tăng `server_epoch`, đổi DNS; client tự resync theo ADR 0002.

Ngưỡng chuyển sang giai đoạn 2 (chạm một trong các ngưỡng là bắt đầu): RAM trống của `.65` dưới 30% lúc cao điểm; số kết nối WS đồng thời vượt mức đã đo là an toàn trên `.65`; p99 gửi → ack vượt ngân sách hai ngày liên tiếp; hoặc cần cam kết RPO = 0 cho khách hàng.

Non-functional:
- Giai đoạn 1: RPO bằng độ trễ WAL archiving (mục tiêu ≤ 1 phút), RTO ≤ 1 giờ.
- Giai đoạn 2: RPO = 0 cho dữ liệu tin nhắn (commit đồng bộ), RTO ≤ 1 giờ cho Postgres.
- Mã hoá at-rest cho volume Postgres, S3, backup.

## Related Code Files

Create:
- `deploy/single-host/` (giai đoạn 1: `ecosystem.config.cjs` cho pm2, server block nginx theo host và theo tenant, script setup server, backup)
- `deploy/k8s/` (giai đoạn 2: Helm chart hoặc Kustomize cho từng role)
- `deploy/observability/` (dashboard JSON, alert rules)
- `deploy/canary/` (bot canary, cấu hình)
- `.github/workflows/` (bổ sung job build/deploy)
- `docs/operations/` (runbook: deploy, rollback, khôi phục backup, xoay vòng khoá)

## Implementation Steps

Giai đoạn 1:
1. Staging trên `.65` ngay sau Phase 2 (Postgres, Redis, api, gateway) để các phase sau test trên môi trường thật; đo RAM nền của máy trước khi cài.
2. pm2 + nginx cho từng role và host; Postgres một instance + WAL archiving + diễn tập PITR; Redis, Meilisearch bind loopback; media lên S3-compatible ngoài máy.
3. Secret + xoay vòng khoá; credentials API nội bộ IdP (loopback); host và chứng chỉ theo tenant.
4. OpenTelemetry trong server Go, RUM trong `packages/core`; dashboard + alert theo ngân sách latency và RAM của máy.
5. Canary 3 nhà mạng + canary IdP.
6. CI/CD deploy + rollback; runbook (gồm "chat ăn RAM: dừng role nào trước").

Giai đoạn 2 (bắt đầu khi chạm ngưỡng chuyển):
7. Chart cho từng role, HPA theo CPU/kết nối.
8. Postgres HA quorum + backup + diễn tập PITR; Redis Sentinel, Meilisearch hai bản, MinIO/Ceph, CDN.
9. Kênh có xác thực tới API nội bộ IdP (plan phía `hoandat-auth`).
10. Chuyển dữ liệu theo runbook, tăng `server_epoch`, đổi DNS.

## Todo

- [ ] GĐ1: staging trên `.65` + đo RAM nền
- [ ] GĐ1: pm2/nginx + Postgres/WAL/PITR + Redis/Meilisearch loopback + S3 ngoài máy
- [ ] GĐ1: secret + credentials API nội bộ IdP + host/chứng chỉ theo tenant
- [ ] GĐ1: tracing + RUM + dashboard/alert (gồm RAM)
- [ ] GĐ1: canary + CI/CD + runbook
- [ ] GĐ2: chart theo role + autoscale
- [ ] GĐ2: Postgres HA quorum + Redis/Meilisearch/S3/CDN HA
- [ ] GĐ2: kênh tới API nội bộ IdP + chuyển dữ liệu

## Success Criteria

Giai đoạn 1:
- Diễn tập khôi phục Postgres về một thời điểm bất kỳ trong 24 h gần nhất thành công trong ≤ 1 giờ; `server_epoch` tăng, client resync.
- Restart từng process chat trong giờ tải: không mất tin đã ack, client tự nối lại.
- Dưới tải thử, RAM trống của `.65` lúc cao điểm vẫn ≥ 30%; IdP, Localman, Tunelo không bị restart vì thiếu RAM.
- Process dispatcher/fetcher không gọi được tới dải lab nội bộ và các dịch vụ loopback khác (test `safehttp` + firewall).

Giai đoạn 2:
- Kill ngẫu nhiên một pod mỗi role trong giờ tải: không mất tin, client tự nối lại.
- Failover Postgres: `server_epoch` tăng, client resync, không mất tin đã ack.
- Từ pod dispatcher không kết nối được tới Redis/Postgres/Meilisearch (test NetworkPolicy).

Cả hai:
- Dashboard hiển thị đủ các chỉ số trong bảng ngân sách latency, có số liệu từ canary 3 nhà mạng.
- Tenant thử (`inetdev.io.vn`) mở được `chat.inetdev.io.vn` với chứng chỉ hợp lệ, đăng nhập qua `auth.inetdev.io.vn` và không thấy dữ liệu của `hoandat.com`.

## Verification

- Giai đoạn 1: `nginx -t` trên server, `pm2 ls` đủ role, biên bản đo RAM lưu trong `plans/dattqh/reports/`.
- Giai đoạn 2: `helm lint deploy/k8s/*` (hoặc `kustomize build`).
- Biên bản diễn tập khôi phục lưu trong `plans/dattqh/reports/` khi chạy phase.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Chi phí vận hành nhiều thành phần | Trung bình | Giữ v1 tối thiểu (không Kafka, không Scylla); chỉ thêm khi số liệu yêu cầu |
| Cảnh báo phụ thuộc chính sản phẩm đang sập | Trung bình | Kênh dự phòng email/SMS (kênh vận hành, không liên quan đăng nhập người dùng) |
| Chat làm `.65` hết RAM, kéo sập IdP, Localman, Tunelo | Cao | Trần bộ nhớ từng process pm2, alert RAM, ngưỡng chuyển giai đoạn 2, runbook dừng role theo thứ tự |
| Giai đoạn 1 mất dữ liệu trong khoảng WAL chưa archive khi hỏng máy | Trung bình | Archive liên tục ra ngoài máy (mục tiêu ≤ 1 phút); RPO = 0 chỉ cam kết ở giai đoạn 2 |
| IdP chạy trên một server dùng chung, là điểm lỗi đơn cho đăng nhập mới | Trung bình | Phiên đang có không phụ thuộc IdP; cache discovery/JWKS/tenant dùng bản cũ khi IdP lỗi; canary IdP + runbook |

## Security Considerations

- Mạng nội bộ cho DB/Redis/Meilisearch; chỉ gateway/api/botapi/webhook ra internet qua edge.
- Quyền tối thiểu cho service account; audit log truy cập quản trị.

## Rollback

Giai đoạn 1: mỗi deploy là một bản build có tag; rollback bằng chạy lại tag trước qua pm2; backup Postgres trước mọi migration. Giai đoạn 2: image có tag, GitOps để revert được. Chuyển giai đoạn có đường lùi: giữ `.65` chạy chỉ đọc tới khi cụm ổn định.

## Next Steps

Phase 14 chạy load test trên giai đoạn 1 để chốt mức tải an toàn của `.65` và quyết định ra mắt; load test quy mô 100k chạy lại khi đã lên giai đoạn 2.
