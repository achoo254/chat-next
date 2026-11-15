---
title: "AI Agent: workspace chỉ theo máy được chọn, một dấu trạng thái dùng chung"
date: 2026-11-15
---

# AI Agent: workspace chỉ theo máy được chọn, một dấu trạng thái dùng chung

## Bối cảnh
Chủ sở hữu báo 3 việc trên cột AI Agent: nút "+" mở thẳng terminal, hộp thoại Thêm workspace và trạng thái icon/tiêu đề.

## Quyết định
- Nút "+" của workspace: đúng thiết kế (tạo phiên ngay với mặc định của dự án, mở ở chế độ dùng gần nhất trên máy). Không sửa.
- Thêm workspace: Jev không chắc (42/34/24), chủ sở hữu chọn "Tắt tự động". syncHosts không còn ghi thư mục của mọi máy thành workspace; workspace chỉ đến từ hộp thoại hoặc phiên tạo từ app. Giữ dấu "detached" vì thiết bị chạy bản cũ vẫn tự ghi.
- Trạng thái: phiên Game thắp hương thật sự còn agent nền (file subagent vẫn được ghi), nên spinner đúng. Vấn đề là mỗi nơi vẽ một kiểu: gộp StatusGlyph vào status-glyph.tsx, workspace/dự án dùng dấu AI qua runningAi, tab terminal của AI dùng trạng thái phiên thay icon tĩnh và bỏ ký hiệu "✳" Claude Code in trong tiêu đề.

## Kiểm chứng
eslint 0 lỗi, tsc sạch, vitest web 1237 pass. E2E terminal.e2e.ts hỏng 4/6 cả ở HEAD trước thay đổi (bố cục điện thoại/WebKit), test cột dự án pass.

Commit ed7f3e83.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
