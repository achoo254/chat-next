---
phase: 14
title: "Phase 14: Load test, đo ngân sách tốc độ và sẵn sàng phát hành"
status: pending
priority: P1
effort: "M"
dependencies: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]
principles: [2, 7, 1]
---

# Phase 14: Load test, đo ngân sách tốc độ và sẵn sàng phát hành

<!-- Updated: Red Team 2026-10-13 - chat large đo theo ngân sách riêng, kịch bản deadlock đa chat/hot user/bot nhiều group, failover có epoch, conformance SDK, bài thử bot echo 10 phút -->
<!-- Updated: Validation Session 2 2026-10-14 - login fixture + đo IdP/kiểm grant, chaos IdP, checklist client IdP và tenant -->
<!-- Updated: Validation Session 3 2026-10-14 - hai lượt: .65 chốt mức tải an toàn để ra mắt, cụm riêng chứng minh 100k + RPO=0 -->
<!-- Updated: Validation Session 8 2026-10-14 - phụ thuộc thêm Phase 16; kịch bản upload media chạy sau khi Phase 4 xong -->
<!-- Updated: Validation Session 9 2026-10-14 - hai vai: smoke test và phản hồi người dùng sau mỗi release trên prod; load test và checklist là cổng mở công khai ở R9 -->

## Vai trò trong lộ trình phát hành

- Sau mỗi release (R0–R8): smoke test tự động trên prod, đo nhanh các chỉ số ngân sách bằng RUM của người dùng thật, và thu phản hồi của user và nhóm dùng thử.
- Release R9 (mở công khai): load test lượt 1 trên `.65`, chaos, đo client trên thiết bị thật và checklist phát hành bên dưới là cổng trước khi mở đăng ký cho người ngoài hệ sinh thái nội bộ.

## Goal

Chứng minh bằng số liệu rằng hệ thống đạt mọi ngân sách tốc độ, tìm và xử lý điểm nghẽn, rồi quyết định phát hành. Làm hai lượt theo hai giai đoạn hạ tầng của Phase 13: lượt 1 trên `.65` chốt mức tải an toàn (số kết nối, tin/giây) mà vẫn đạt ngân sách latency và chừa ≥ 30% RAM, rồi ra mắt trong giới hạn đó; lượt 2 trên cụm riêng chứng minh quy mô 100k và RPO = 0.

## Context Links

- Bảng ngân sách latency trong `plan.md`
- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md) — ngưỡng chuyển sang ScyllaDB/OpenSearch/NATS
- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — kịch bản burst

## Key Insights

- Mọi con số latency trong nghiên cứu đều là mục tiêu, chưa được benchmark; phase này biến chúng thành số đo thật.
- Quyết định nâng cấp thành phần (NATS JetStream, OpenSearch, ScyllaDB) chỉ dựa trên số đo ở phase này, không làm sớm.

## Requirements

Functional:
- Kịch bản k6 (HTTP + WebSocket), tăng dần tới khi chạm ngân sách latency hoặc ngưỡng RAM ở lượt 1, tới 100k kết nối đồng thời ở lượt 2: gửi/nhận trong chat 1-1 và group (200 `small`, 10k và 100k `large`), chuyển mode 200→201, nhiều chat chồng chéo thành viên, hot user trong 100 group, bot là thành viên 5.000 group, mở chat, cuộn lịch sử, search (người dùng 3.000 chat), upload media, webhook burst 2.000 req/s, bulk 100k người nhận, bot long poll + webhook.
- Đăng nhập trong load test: phiên chat tạo sẵn bằng fixture trên staging (không đi qua Google/GitHub); kịch bản riêng đo đăng nhập thật qua IdP staging ở tốc độ thấp, và đo job kiểm grant với 100k phiên để chứng minh không vượt rate limit `/token` của IdP.
- Conformance SDK (Phase 15) trên staging; bài thử "bot echo trong 10 phút" với một lập trình viên ngoài đội.
- Chaos: kill pod/process (kể cả dispatcher giữa lúc xử lý action trong body), IdP dừng 30 phút (phiên đang có phải chạy bình thường), mất Redis, Postgres failover ở lượt 2 hoặc restore PITR ở lượt 1 (kiểm `server_epoch`), mất một node search, mạng chập chờn ở client.
- Đo client trên thiết bị thật: cold start, mở chat, cuộn, gửi → ack (web, 2 iPhone, 2 Android, 3 hệ điều hành desktop).
- Báo cáo kết quả so với ngân sách; danh sách điểm nghẽn và cách xử lý.
- Checklist phát hành: security scan, pen-test cơ bản, data inventory, chính sách quyền riêng tư, điều khoản, hồ sơ App Store/Google Play, branding cấu hình đúng, client `chat-web`/`chat-mobile`/`chat-desktop` đã khai ở IdP production, app chat có trên trang `/apps` của IdP, kiểm cô lập tenant trên tenant thử.

Non-functional (ngân sách latency phải đạt ở cả hai lượt, ở mức tải của lượt đó; quy mô ~100k người dùng hoạt động chỉ áp cho lượt 2):

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

## Related Code Files

Create:
- `load/` (kịch bản k6: `chat-mix.js`, `group-fanout.js`, `search.js`, `webhook-burst.js`, `bulk.js`, `bot-delivery.js`)
- `load/chaos/` (kịch bản chaos)
- `plans/dattqh/reports/` (báo cáo load test khi chạy)

## Implementation Steps

1. Sinh dữ liệu giả lập quy mô v1 (người dùng, chat, lịch sử) trên staging cỡ production.
2. Chạy từng kịch bản riêng, rồi kịch bản trộn theo tỷ lệ tải thực tế ước lượng.
3. Thu thập số liệu từ dashboard Phase 13; so với ngân sách.
4. Profile điểm nghẽn (pprof, `pg_stat_statements`), sửa trong phase tương ứng, chạy lại.
5. Chaos test.
6. Đo client trên thiết bị thật.
7. Checklist phát hành + quyết định go/no-go.

## Todo

- [ ] Dữ liệu giả lập quy mô v1
- [ ] Kịch bản k6 đầy đủ
- [ ] Chạy + so ngân sách
- [ ] Sửa điểm nghẽn + chạy lại
- [ ] Chaos test
- [ ] Đo thiết bị thật
- [ ] Checklist phát hành + go/no-go

## Success Criteria

- Mọi chỉ số trong bảng đạt ngưỡng ở hai lần chạy liên tiếp.
- Chaos test không làm mất tin; client tự phục hồi.
- Checklist phát hành hoàn tất, không còn finding bảo mật mức high/critical.

## Verification

- `k6 run load/chat-mix.js` (và các kịch bản khác) trên staging
- Báo cáo load test trong `plans/dattqh/reports/`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Không đạt ngân sách ở group rất lớn | Trung bình | Điều chỉnh ngưỡng fan-out, chuyển per-chat log, NATS |
| Staging không giống production | Trung bình | Cùng chart, cùng cấu hình, khác quy mô có ghi chép |

## Security Considerations

- Dữ liệu load test là dữ liệu giả, không dùng dữ liệu thật của người dùng.
- Pen-test cơ bản cho auth, Bot API, webhook, media URL.

## Rollback

Không thay đổi production ngoài các bản sửa đã qua phase tương ứng. Quyết định no-go giữ phát hành ở kênh thử nghiệm.

## Next Steps

Sau v1: plan riêng cho secret chat E2E, cuộc gọi, và các nâng cấp thành phần theo số đo.
