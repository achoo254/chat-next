# Phase 1: Proto + agent: gửi tin lấy phiên khỏi terminal

Tier: M · Phụ thuộc: không (phương án B đã chốt) · Trạng thái: xong 18/11/2026

## Proto (`proto/remote/v1/remote.proto`, sinh lại TS + Go)
- `ProviderCapabilities.chat_takes_terminal = 20` (bool): `ThreadSend` vào luồng terminal đang giữ thì lấy phiên về
  Trò chuyện thay vì từ chối. Máy cũ không đặt → web giữ hành vi cũ.
- `ERROR_REASON_TERMINAL_TURN_RUNNING = 87`: terminal của luồng đang chạy một lượt hoặc chờ duyệt; subject rỗng.
  (Kiểm số 87 còn trống ngay trước khi sửa: phiên khác vừa dùng 86.)

## Agent
- `src/core/agent-core.ts` `send()`: thay chỗ từ chối `t.meta.terminal || t.launching`:
  - `t.launching` (CLI đang khởi động): vẫn từ chối như cũ.
  - `t.meta.terminal`: gọi `terminalIdle(threadId, QUIET_MS)` (đề xuất 1500 ms). Sai → `TERMINAL_TURN_RUNNING`.
    Đúng → đánh dấu luồng đang bàn giao (chặn mở terminal và tin thứ hai trong lúc này), gọi đóng phiên PTY qua
    callback mới trong opts của core (`closeTerminal(session)` do `terminal-service` cấp), chờ `endTerminal` (sự kiện
    `session_exit` hoặc gọi thẳng sau khi `close` xong, có hạn chờ), rồi đi tiếp đường gửi bình thường.
  - Không thêm lý do kết thúc vào giao thức: web (phase 2) nhận ra phiên terminal kết thúc vì Trò chuyện lấy lại khi
    luồng có lượt mới từ Trò chuyện ngay sau đó.
- `src/machine.ts`: đặt `chatTakesTerminal: p.terminal !== undefined` trong capabilities.
- `src/terminal/terminal-service.ts`: cấp `close` cho core; đánh dấu phiên đóng có chủ đích để không báo lỗi.

## Rủi ro
- Đóng CLI lúc nó vừa bắt đầu lượt mới sau lần kiểm: kiểm lại `terminalIdle` ngay trước `close`; CLI bị treo máy
  giữa lượt thì transcript vẫn đọc được, lượt dở hiện như bị ngắt.
- CLI đổi phiên (`/clear`) ngay trước khi gửi: `endTerminal` gọi `followTerminal`, luồng nhận phiên mới trước khi resume.

## Test (`apps/agent/test/`)
- Mới `terminal-chat-takeover.test.ts`: rảnh → đóng PTY, tin chạy bằng resume đúng phiên; bận/chờ duyệt →
  `TERMINAL_TURN_RUNNING`, PTY còn; đang khởi động → `SESSION_OPEN_ELSEWHERE`; hai tin cùng lúc → chỉ một lần bàn giao.
- Sửa test cũ đang chờ `SESSION_OPEN_ELSEWHERE` khi gửi vào luồng terminal giữ.
- Lệnh: `pnpm --filter @app/agent test -- terminal` rồi cả bộ agent một lần (`--maxWorkers=2`).

## Đã làm
- `takeFromTerminal()` + `waitTerminalCliGone()` trong `agent-core.ts`: rảnh 1,5 giây mới lấy; đóng PTY, trả phiên, chờ
  tối đa 5 giây cho CLI thoát (hỏi `openInOtherProcess`); tin đến cùng lúc dùng chung một lần bàn giao; mở terminal
  trong lúc bàn giao bị `THREAD_RUNNING`.
- `machine.ts`: `closeTerminal` bỏ qua `no_such_session` (CLI đã tự thoát); cờ `chatTakesTerminal`.
- Test `terminal-chat-takeover.test.ts` 5/5; nhóm test terminal 125 đạt; cả bộ agent 1568 đạt, 2 lỗi do máy thiếu
  `lsof` và lệnh giải nén (không liên quan).
