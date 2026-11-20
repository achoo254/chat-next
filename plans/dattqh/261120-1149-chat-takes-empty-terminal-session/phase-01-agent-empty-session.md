# Phase 1: Agent: phiên trống mà CLI giữ được coi là rảnh

Tier: M · Phụ thuộc: không · Trạng thái: xong 20/11/2026 (chưa commit, chưa phát hành)

## Việc
1. Đo trước: mở CLI mới ở thư mục thử, ghi lại thời gian từ lúc nhấn Enter tin đầu đến lúc file transcript xuất hiện, và
   xem sổ đăng ký tiến trình đã có bản ghi cho `--session-id` ngay khi CLI khởi động chưa. Kết quả quyết định `quietMs`
   cho phiên trống và xác nhận phương án A khả thi.
2. `apps/agent/src/providers/claude/local-sessions.ts` `liveness()`: khi `locate()` không thấy phiên, tra
   `registers()` tìm đúng một tiến trình claude đang chạy (`runsAsRecorded`) đăng ký `sessionId`; có thì trả `idle`, `held`,
   `turnOpen: false`, `since` là lúc CLI khởi động, `via: "process"`. Không có hoặc có nhiều hơn một: như cũ (`unknown`).
3. `apps/agent/src/providers/types.ts` `Liveness`: thêm cờ nói "chưa có transcript" nếu `terminalIdle` cần phân biệt (chỉ
   thêm khi thật sự dùng).
4. `apps/agent/src/core/agent-core.ts` `terminalIdle()` (dòng 3510): chỉ bỏ `history.end() === undefined` khi liveness báo
   phiên trống mà CLI giữ; mọi điều kiện khác (`t.running`, `queued`, `pending`, `outsidePrompts`, `quietMs`) giữ nguyên.
5. Sau khi đóng CLI ở `takeFromTerminal`: nếu phiên không có transcript thì bỏ `seg.sessionId` (hoặc mở với id đó nếu bước
   đo ở "Câu hỏi còn mở" cho phép), xoá `t.untranscribedHeld`, để `startTurn` không `--resume` một phiên không tồn tại.
6. Chú thích đầu `terminalIdle` và `takeFromTerminal`: sửa câu "its session has a transcript to resume" cho đúng với phiên trống.

## Test (`apps/agent/test/terminal-chat-takeover.test.ts`, thêm ca mới)
- Phiên trống, `end()` trả `undefined`, liveness báo CLI giữ và rảnh đủ lâu → `send` thành công, terminal đóng, lượt chạy,
  `startTurn` không nhận `resumeId` của phiên trống.
- Phiên trống, CLI vừa khởi động chưa đủ `quietMs` → `TERMINAL_TURN_RUNNING`, chữ còn.
- Phiên trống, có hơn một tiến trình đăng ký cùng id hoặc không có tiến trình nào → từ chối như cũ.
- Phiên có transcript: mọi ca cũ (rảnh, bận, chờ duyệt, `/clear`, đang khởi động) giữ kết quả.
- Test `local-sessions` cho nhánh liveness mới (có/không bản ghi tiến trình).

## Kiểm
- Chạy file test liên quan trước (`vitest run apps/agent/test/terminal-chat-takeover.test.ts`), sau đó `pnpm typecheck` và
  lint. Chạy cả bộ agent một lần ở cuối, giữ `maxWorkers: 2` theo cấu hình repo.

## Rủi ro và rollback
- Rủi ro: đóng CLI đúng lúc người dùng vừa nhấn Enter tin đầu (cửa sổ chưa có transcript). Giảm bằng `quietMs` và đo ở
  bước 1; ghi lại trong ADR/docs nếu còn tồn tại.
- Rollback: hoàn nguyên nhánh trong `terminalIdle` và `liveness`; hành vi trở về từ chối phiên trống như hiện tại.

## Đã làm (20/11/2026)
- Bước đo: sổ đăng ký `~/.claude/sessions/<pid>.json` ghi `sessionId` ngay khi CLI khởi động và có thêm `status`
  (`idle`/`busy`) cùng `statusUpdatedAt` do chính Claude cập nhật. Dùng `status` thay cho đo thời gian từ Enter đến dòng
  transcript đầu tiên: phiên trống chỉ được coi là rảnh khi bản ghi nói `idle`, nên tin vừa gõ (busy) bị từ chối. Chưa đo
  trực tiếp việc `status` đổi sang `busy` ngay lúc nhấn Enter; kiểm ở phase 2 (ca 4).
- `local-sessions.ts`: `Register` đọc thêm `status`, `statusUpdatedAt`; `liveness()` khi không có transcript gọi
  `idleBeforeFirstMessage()` (đúng một claude không phải SDK, `status === "idle"`, còn chạy đúng như bản ghi) và trả
  `{ idle, since: statusUpdatedAt, held, turnOpen: false, untranscribed: true, via: "process" }`.
- `types.ts`: `Liveness.untranscribed`.
- `agent-core.ts`: `terminalIdle` chỉ bỏ điều kiện "có transcript" khi `untranscribed`; `quietMs` giữ 1,5 giây, tính từ
  `statusUpdatedAt`. `takeFromTerminal` gọi `forgetUntranscribedSession` sau khi CLI thoát: bỏ `seg.sessionId` chưa từng
  được ghi và xoá `untranscribedHeld`, để Trò chuyện mở phiên mới thay vì `--resume` một phiên không tồn tại.
- Câu hỏi mở "SDK có cho mở phiên với id chọn trước không": không cần, chọn cách bỏ `sessionId`.

## Nghiệm thu phase 1 (20/11/2026, Mac mini)
- Test mới: 2 ca trong `terminal-chat-takeover` (lấy lại phiên trống và phiên mới không `resumeId`; từ chối khi busy, vừa
  idle 200 ms, unknown) và 3 ca trong `local-sessions` (idle có `untranscribed`; busy / không status / SDK / hai claude /
  không chạy → unknown; phiên có transcript không bao giờ `untranscribed`).
- Kiểm ngược: tạm bỏ nhánh `untranscribed` ở `terminalIdle` thì ca lấy lại phiên trống thất bại; đã khôi phục.
- `tsc --noEmit` 0 lỗi; `eslint --max-warnings=0` trên 5 file đã sửa sạch.
- Bộ agent đầy đủ: 1604 đạt, 6 thất bại ngoài phạm vi: `os-integration` (2), `terminal-units` (launchd), `mac-sandbox`,
  `workspace-security` (cần `ps`/`lsof`/`sandbox-exec`/`launchctl`, bị chặn trong shell này), `update` (script phát hành
  thoát 127, thiếu lệnh). `machine-profile` thất bại một lần khi chạy cả bộ, chạy riêng hai lần đều đạt. Chưa chạy lại các
  ca bị chặn ngoài shell giới hạn.
