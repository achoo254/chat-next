---
title: Phase 1 nền móng chat-next và client chat ở hoandat-auth
date: 2026-10-14
summary: "Contract, ADR 0001-0010, helper TS/Go, brand, Compose, CI cho chat-next; ba client chat ở hoandat-auth; mock UI; review 15 điểm đã sửa"
---

# Phase 1 nền móng chat-next và client chat ở hoandat-auth

## Đã làm
- hoandat-auth (nhánh `feat/chat-app-clients`, commit `0c0020d`, `4a9ca7d`, chưa push): client `chat-web`, `chat-mobile`, `chat-desktop`; refresh native không chết theo phiên IdP và không trần 90 ngày nhờ `expiresWithSession`; redirect mobile đọc từ `CHAT_MOBILE_REDIRECT_URI`. 502 test, 10 e2e sạch.
- chat-next Phase 1 (chưa commit, repo chưa có remote): monorepo pnpm + Go module, proto 10 domain sinh Go/TS, ADR 0001–0010, fold tiếng Việt / ID / entities ở cả TS và Go trên vector dùng chung, `brand.config.json` + generator + `check-brand`, Docker Compose dev, GitLab CI. 639 test TS, 5 package Go, golangci-lint 0 issue.
- Mock UI `plans/dattqh/261013-0448-chat-platform-v1/mockups/chat-ui-mockup.html` theo token hệ sinh thái (slate + violet).

## Sự cố và bài học
- protobuf-es bỏ qua `jstype = JS_NUMBER`, TS nhận `bigint`; Jev chọn giữ protobuf-es và đổi sang `number` ở lớp ánh xạ của core.
- `Intl.Segmenter` (ICU) không theo UAX #29 thuần cho CJK/Đông Nam Á; phải thêm tailoring vào SPEC để Go (`uniseg`) khớp. FTS5 `unicode61` lại tự tách token, nên index và truy vấn phải dùng `searchText` với `categories 'L* N* M* P* S* C*'`; có test FTS5 thật trên `node:sqlite`.
- Review bắt được CI job `proto` chạy image Node nhưng plugin Go cần `go`; healthcheck Postgres qua socket báo sẵn sàng sớm làm standby đồng bộ chết và primary treo commit; link `google.com@evil.com` lọt allowlist.
- Ghidra auto-analysis binary Telegram 254MB quá nặng cho máy 16GB dùng chung; kiểm kê chuỗi đã đủ cho plan.

## Quyết định (Jev)
- Outbox giữ 30 ngày; RPC thiếu thêm ở phase sở hữu; hạ tầng `.65` trước, cụm riêng sau; bắt đầu chat Phase 1 trước IdP Phase 02.

## Việc tiếp
- User duyệt mock UI trước Phase 6.
- Chạy Docker Compose và CI khi có Docker và remote GitLab; tenant thứ hai cần script seed ở hoandat-auth Phase 02.
- `brand.config.json` còn domain `.invalid` cho media và Mini App.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
