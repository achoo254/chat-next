---
phase: 9
title: "Phase 9: Thông báo qua Bot và incoming webhook — đường xử lý cực nhanh"
status: pending
priority: P1
effort: "L"
dependencies: [2, 3, 8]
principles: [2, 6, 3, 7]
---

# Phase 9: Thông báo qua Bot và incoming webhook — đường xử lý cực nhanh

<!-- Updated: Red Team 2026-10-13 - trả (chat_id, seq), chỉ accepted + bộ đếm (quyết định user), notify_groups chống race + so startsAt, bulk dùng endpoint Phase 8, Slack mrkdwn + GitLab qua Mattermost, Discord/Zabbix sang v1.1, vòng đời hook theo quyền admin, redact secret -->
<!-- Updated: Validation Session 2 2026-10-14 - URL hook theo host của tenant -->
<!-- Updated: Validation Session 9 2026-10-14 - incoming webhook lên prod ở R2 trước bot; phần bot và bulk ở R5 -->

## Goal

Hệ thống bên ngoài (monitoring, CI/CD, billing, ứng dụng nghiệp vụ) gửi thông báo vào chat/group/channel qua Bot API hoặc URL webhook, được xác nhận trong vài chục mili-giây và tới người nhận gần như ngay lập tức, kể cả khi bắn hàng loạt.

## Context Links

- [Pipeline thông báo](../reports/researcher-261013-1120-notification-pipeline.md) — format, fast path, lanes, latency, ma trận công cụ
- Phase 2 (fast path, ratelimit), Phase 3 (lanes, push), Phase 8 (Bot API, bulk, safehttp)

## Key Insights

- Không cần message broker ở v1: chi phí chính là một commit Postgres. Mục tiêu POST → 200 khoảng 15 ms p50 / 50 ms p99 server-side (cộng chi phí commit đồng bộ, đo ở Phase 14).
- Mọi format quy về một ingest path; mỗi format là một mapper.
- Slack-compatible phải trả đúng `ok` dạng text (Grafana so từng byte); phải parse mrkdwn (`<url|text>`, `*bold*`, escape `&lt;`).
- GitLab không còn tích hợp Slack phù hợp và chặn URL Discord, nên đi qua **tích hợp Mattermost** tới endpoint Slack-compatible.
- `idempotency_key` cho retry; `group_key` cập nhật tại chỗ alert lặp — cần khoá theo `(hook_id, group_key)` và so thời điểm nguồn để tránh race và sai thứ tự firing/resolved.
- Trạng thái giao theo quyết định của user: **chỉ accepted + bộ đếm tổng hợp**, không callback, không ghi dòng cho từng người nhận.

## Thứ tự trong lộ trình phát hành

- Release R2: incoming webhook (tạo hook, định dạng native/Slack/Alertmanager, cập nhật tại chỗ theo `group_key`, bộ đếm, tự tắt khi người tạo mất quyền). Phần này chỉ cần Phase 2 và 3, không cần Bot API.
- Release R5: thông báo qua bot và gửi hàng loạt `POST /bot/v1/messages:bulk`, đi cùng Phase 8.

## Requirements

Functional:
- Incoming webhook gắn với một chat (và thuộc tenant của chat đó), URL dạng `https://chat.<d>/hook/{id}/{secret}`; hook gọi sai host tenant trả 404. Do admin tạo; lưu `created_by`; hook tự tắt khi người tạo mất quyền admin hoặc rời chat (qua outbox `member_permissions`/`member_removed`), admin khác có thể nhận lại; mặc định giữ nguyên URL để công cụ giám sát chạy tiếp, admin bật "xoay secret khi nhận lại" nếu không muốn người cũ dùng URL nữa.
- Secret trong URL lưu hash, hiển thị một lần, xoay vòng có thời gian ân hạn 7 ngày với hai secret song song (thu hồi ngay được nếu URL cũ lộ); path được redact ở edge và logger.
- Format v1: JSON riêng (`text`, `entities`/`parse_mode`, `buttons`, `silent`, `idempotency_key`, `group_key`, `priority`); Slack-compatible (`text` mrkdwn, `blocks`/`attachments` cơ bản); Alertmanager native (`groupKey`, `status`, `startsAt`/`endsAt`).
- Format v1.1 (không làm trong phase này): Discord-compatible, kèm tài liệu Zabbix.
- Bot gửi thông báo qua Bot API Phase 8; gửi hàng loạt dùng duy nhất `POST /bot/v1/messages:bulk`.
- `priority=alert` chỉ có hiệu lực khi admin chat cho phép; mặc định `transactional` cho webhook.
- Response: `{chat_id, seq}` (theo ADR 0001), hoặc với bulk: `{request_id, accepted_count}`.
- Bộ đếm theo hook/bot và theo request bulk: `accepted`, `delivered_realtime` (đã đẩy tới ít nhất một session online), `push_accepted` (FCM/APNs/Web Push nhận), `failed`; đọc qua API và UI.
- Tin từ hook mang `integration_label` để client hiển thị "Tích hợp: <tên>"; URL button đi qua allowlist scheme.
- Audit log và dead-letter cho request không xử lý được.

Non-functional:
- Webhook POST → 200: p50 ≈ 15 ms, p99 ≈ 50 ms (server-side).
- Webhook → client online: p50 ≤ 100 ms, p99 ≤ 300 ms.
- Push được FCM/APNs nhận: p50 ≤ 200 ms, p99 ≤ 1 s.
- Bulk 100k người nhận không làm p99 làn alert/transactional tăng quá 20%.

## Architecture

```
POST /hook/{id}/{secret}[/slack|/alertmanager]
  └─> redact path trong log → auth (constant-time) → ratelimit (Phase 2)
  └─> mapper → NotificationRequest
  └─> 1 tx: idempotency + notify_groups (SELECT … FOR UPDATE, bỏ qua payload cũ hơn) + fast path Phase 2 + outbox
  └─> 200 {chat_id, seq}
  └─> afterCommit: realtime (Phase 3) + push (lane theo priority) + tăng bộ đếm (Redis, flush định kỳ)
bulk: tách lô vào làn bulk, worker riêng, chỉ người nhận có consent
```

Khi scale: relay outbox sang NATS JetStream, giữ nguyên contract.

## Related Code Files

Create:
- `server/internal/hooks/` (router, secret, rotate, lifecycle theo quyền, audit)
- `server/internal/hooks/format/{native,slack,alertmanager}.go` (+ `mrkdwn` parser)
- `server/internal/notify/` (NotificationRequest, idempotency, notify_groups, counters)
- `server/migrations/00xx_hooks_notify.sql`
- `packages/ui/src/components/integrations/`
- `docs/integrations/` (Grafana, Alertmanager, GitLab qua Mattermost, Uptime Kuma, Jenkins)
- `server/testdata/hooks/` (payload thật từng công cụ)

## Implementation Steps

1. Schema: `incoming_hooks` (chat_id, created_by, secret_hash, secret_hash_prev, prev_expires_at, format, state, allow_alert), `notify_idempotency` (TTL 24 h), `notify_groups` (hook_id, group_key PK, chat_id, seq, last_status, source_ts), `notify_counters`, `hook_audit`.
2. Router + redact + auth + ratelimit.
3. Mapper native, Slack (mrkdwn), Alertmanager; fixture thật của Grafana, Alertmanager, GitLab (Mattermost integration), Uptime Kuma, Jenkins.
4. `group_key`: khoá dòng, so `source_ts` (`startsAt`/`endsAt`), sửa tin cũ, chỉ push khi trạng thái đổi.
5. Lane theo priority; bulk qua endpoint Phase 8.
6. Bộ đếm Redis + flush; API + UI xem.
7. Vòng đời hook theo quyền admin.
8. UI tạo/xoay vòng/tắt hook.
9. Docs tích hợp.
10. Canary end-to-end mỗi phút (Phase 13 giám sát).

## Todo

- [ ] Schema hooks/notify
- [ ] Router + redact + auth + ratelimit
- [ ] Mapper native/Slack mrkdwn/Alertmanager + fixture thật
- [ ] notify_groups chống race + thứ tự
- [ ] Lanes + bulk dùng endpoint Phase 8
- [ ] Bộ đếm + API/UI
- [ ] Vòng đời hook theo quyền
- [ ] UI quản lý hook
- [ ] Docs tích hợp
- [ ] Canary

## Success Criteria

- Grafana, Alertmanager, GitLab (qua Mattermost), Uptime Kuma, Jenkins gửi được thông báo vào chat không cần plugin riêng (instance thật ở dev); link mrkdwn hiển thị đúng.
- Cùng `idempotency_key` gửi 100 lần chỉ tạo một tin.
- Hai firing song song cùng `groupKey` chỉ tạo một tin; resolved đến trước firing (theo thời gian nguồn) thì trạng thái cuối vẫn là resolved.
- Người tạo hook bị gỡ admin → hook ngừng nhận trong ≤ 5 s.
- Secret không xuất hiện trong log (test quét log).
- Load test: 2.000 webhook/s trong 5 phút, p99 POST → 200 ≤ 50 ms; đồng thời bulk 100k, p99 làn alert tăng ≤ 20%.

## Verification

- `cd server && go test ./internal/hooks/... ./internal/notify/... -race`
- `k6 run load/webhook-burst.js`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Postgres nghẽn khi burst | Trung bình | Đo Phase 14; micro-batch làn bulk; JetStream khi cần |
| Hook bị lộ thành kênh phishing | Trung bình | Nhãn tích hợp, allowlist scheme, cảnh báo link, xoay vòng secret |

## Security Considerations

- Secret hash, redact, xoay vòng; giới hạn payload 64 KB; IP allowlist tuỳ chọn cho mỗi hook.
- Không có callback ra ngoài trong v1 (giảm bề mặt SSRF).

## Rollback

Role riêng; tắt role thì Bot API vẫn gửi được; mapper bật/tắt bằng cấu hình.

## Next Steps

Phase 14 load test; v1.1: Discord-compatible + Zabbix.
