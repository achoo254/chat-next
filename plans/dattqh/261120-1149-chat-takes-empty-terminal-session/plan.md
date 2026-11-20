---
title: "Trò chuyện lấy lại được phiên trống đang mở trong terminal"
description: "Phiên mới mở ở terminal mà chưa có tin nào bị coi là bận, nên gửi tin từ Trò chuyện luôn bị từ chối dù CLI đang rảnh."
status: in-progress
priority: P2
tags: [agent, terminal, bug]
blockedBy: []
blocks: []
created: 2026-11-20
---

# Trò chuyện lấy lại được phiên trống đang mở trong terminal

Tier: M (agent + test; web không đổi) · Bổ sung cho [plan 261118-0922](../261118-0922-chat-sends-to-terminal-session/plan.md), không thay luật của nó.

## Kết quả mong muốn
- Phiên mới mở ở terminal, CLI đang rảnh ở ô nhập, chưa có tin nào: gõ tin ở Trò chuyện thì terminal đóng và tin chạy
  ở Trò chuyện, như phiên đã có lượt.
- Lịch sử không mất gì (phiên trống thì không có gì để mất), tin đầu tiên đặt tên phiên như mọi phiên mở không tin.
- Giữ nguyên các luật cũ: CLI đang chạy lượt, chờ duyệt, hoặc vừa có hoạt động thì vẫn bị từ chối
  `TERMINAL_TURN_RUNNING`, chữ còn trong ô soạn.

## Không làm
- Không đổi chữ banner hay chữ lỗi ở web (banner đúng; câu lỗi đúng khi CLI thật sự bận).
- Không thêm lệnh vào daemon `term-host`, không đổi proto.
- Không gỡ điều kiện "phải có transcript" cho phiên đã có lượt: nó là điều kiện để mở lại bằng `--resume`.

## Nguyên nhân (đã chứng minh)
Thử thật trên chat.hoandat.com ngày 20/11 (tunelo trên Mac mini): phiên mới → tab Terminal → quay lại Trò chuyện → gửi tin
bị từ chối `TERMINAL_TURN_RUNNING` sau 10 giây và sau 20 giây; cho terminal trả lời một lượt rồi gửi lại thì chạy được.

Đường mã:
1. `terminalCommand` (`providers/claude/index.ts:333`) mở phiên mới bằng `--session-id <id>`; `agent-core.ts` gán id đó vào
   `seg.sessionId` ngay lúc mở. Claude chỉ tạo file transcript khi có tin đầu tiên.
2. `send()` → `takeFromTerminal()` → `terminalIdle()` (`agent-core.ts:3503`). Dòng 3510:
   `history.end(seg.sessionId) === undefined` trả `false` vì chưa có file. Chú thích của hàm đã nói "False whenever it
   cannot tell"; phiên trống rơi vào đúng nhánh này dù thực tế CLI rảnh.
3. `takeFromTerminal` đổi `false` thành `TERMINAL_TURN_RUNNING` ("đang trả lời hoặc chờ duyệt"): câu sai với phiên trống.

## Phương án

**A (khuyến nghị): coi phiên trống mà CLI giữ là rảnh, nhận từ bản ghi tiến trình của Claude.**
`liveness()` (`local-sessions.ts:292`) khi không có transcript hỏi sổ đăng ký tiến trình (`registers()`, đã dùng cho
`held` và `openInOtherProcess`): nếu có đúng một claude đang chạy đăng ký chính `sessionId` này, trả
`{ state: "idle", held: true, turnOpen: false, since: <lúc CLI khởi động>, transcript: false }`. `terminalIdle` bỏ điều
kiện `end() === undefined` khi liveness nói vậy, phần còn lại (quiet, không prompt, không lượt) giữ nguyên.
- Ưu: chỉ đổi ở provider Claude và một nhánh trong `terminalIdle`; dùng lại sổ đăng ký, đã được test.
- Nhược: cửa sổ rất ngắn giữa lúc người dùng nhấn Enter tin đầu tiên ở terminal và lúc Claude ghi dòng đầu của transcript.
  Trong cửa sổ đó gửi từ Trò chuyện sẽ đóng CLI đúng lúc nó bắt đầu lượt. Giảm bằng `quietMs` tính từ lúc CLI khởi động và
  từ lần ghi cuối của thư mục phiên (`terminalCliQuiet` đã có); không loại hẳn được.

**B (không khuyến nghị): chặn gửi tin cho tới khi có transcript.** Giữ lỗi hiện tại, chỉ đổi câu thành "gõ một tin ở
terminal trước". Không sửa gì mà người dùng thấy ô nhập mở rồi vẫn bị từ chối.

**C (không khuyến nghị): tắt hẳn việc chiếm phiên khi trống.** Gửi tin mở một phiên Trò chuyện mới song song với CLI. Hai
tiến trình cùng một thư mục, hai transcript, vi phạm luật "một phiên một nơi ghi".

## Điều phải xử lý khi đóng một phiên trống
Sau khi đóng CLI, `startTurn` của Trò chuyện mở bằng `resumeId = seg.sessionId` (`providers/claude/index.ts:791`). Phiên
chưa có transcript thì `--resume` báo không tìm thấy. Phase 1 phải chọn một trong hai cách và chứng minh bằng test:
- bỏ `seg.sessionId` của đoạn trống để Trò chuyện mở phiên mới (khuyến nghị: không phụ thuộc SDK), hoặc
- mở phiên mới với đúng id đó nếu SDK cho đặt id (cần xác minh, không đoán).

Cùng chỗ: `t.untranscribedHeld` (phiên trên màn hình lúc CLI kết thúc chưa có transcript) phải xoá khi lấy lại phiên trống.

## Phase
| # | Phase | Tier | Trạng thái |
|---|---|---|---|
| 1 | [Agent: phiên trống mà CLI giữ được coi là rảnh, mở lại bằng phiên mới](phase-01-agent-empty-session.md) | M | xong (chưa commit) |
| 2 | [Nghiệm thu máy thật, docs, phát hành tunelo](phase-02-verify-release.md) | S | chờ |

## Tiêu chí nghiệm thu
- Test agent: phiên trống + CLI giữ + rảnh → gửi được, terminal đóng, tin chạy ở Trò chuyện, không còn `sessionId` cũ.
- Test agent: phiên trống + CLI vừa khởi động chưa đủ `quietMs` hoặc có tiến trình khác giữ → vẫn từ chối.
- Test agent: phiên đã có lượt chạy y như cũ (không đổi kết quả của bộ `terminal-chat-takeover`).
- Thử lại đúng kịch bản của buổi thử 20/11 trên máy thật: phiên mới → Terminal → Trò chuyện → gửi → chạy ngay.
- Typecheck, lint sạch; phát hành tunelo, ghim script cài.

## Câu hỏi còn mở
- Đã chốt ở phase 1: bỏ `sessionId` của phiên trống (không cần SDK nhận id chọn trước); `quietMs` giữ 1,5 giây vì phiên trống
  dựa vào `status` của chính Claude.
- Còn mở: `status` của Claude có sang `busy` ngay lúc nhấn Enter tin đầu không. Phase 2 kiểm trên máy thật (ca 4).
