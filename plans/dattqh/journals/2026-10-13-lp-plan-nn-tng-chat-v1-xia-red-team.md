---
title: Lập plan nền tảng chat v1 (xia + red-team)
date: 2026-10-13
summary: Từ ý tưởng app chat hiệu năng ngang Telegram tới plan 15 phase đã qua red-team và validation
---

# Lập plan nền tảng chat v1 (xia + red-team)

## What happened
- Repo greenfield. Chạy xia (mode port): 5 luồng nghiên cứu về client web Telegram (telegram-tt, tweb — GPL-3.0, chỉ học kỹ thuật), Bot platform, backend sync/search, đóng gói Capacitor/Tauri, pipeline thông báo.
- Kiểm chứng thực tế: SQLite FTS5 `remove_diacritics 2` fold được dấu thanh nhưng KHÔNG fold `đ/Đ` → cần hàm fold ứng dụng dùng chung TS/Go.
- Giữa phiên, user làm rõ: sản phẩm và bot hoàn toàn độc lập với Telegram (chỉ học hiệu năng/kiến trúc); tên sản phẩm cấu hình được. Đã bỏ hướng Bot API tương thích Telegram, đổi tên plan.
- Plan: `plans/dattqh/261013-0448-chat-platform-v1/` — 15 phase, 128 task.

## Decision
- React 19, Go, Postgres (replica đồng bộ quorum + `server_epoch`), Redis, Meilisearch (chia index theo hash chat_id + re-rank theo dấu), S3 + CDN, self-host VN.
- Sync kiểu pts/getDifference; outbox dạng log có cursor riêng mỗi consumer + afterCommit dispatch.
- Bot API riêng `/bot/v1` + OpenAPI + SDK TS/Python/Go + Developer Console; consent invariant chống spam.
- Incoming webhook: native, Slack-compatible (GitLab qua Mattermost), Alertmanager; chỉ accepted + bộ đếm.
- Đăng ký chỉ bằng email.
- Red-team: 40 finding → 15, áp dụng hết. 7 Critical: failover làm pts lùi, outbox mất thứ tự, deadlock fan-out, chat large đứt luồng, Worker không gọi được plugin native, bot spam thiếu consent, lưu phiên web chưa chốt.

## Next steps
- Chạy `/ak:cook plans/dattqh/261013-0448-chat-platform-v1/plan.md`, bắt đầu Phase 1 (ADR 0001–0009, proto, fold).
- Spike sớm: native bridge Capacitor/Tauri (Phase 5), throttling Tauri (Phase 11), FTS5 trong build SQLCipher (Phase 10).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
