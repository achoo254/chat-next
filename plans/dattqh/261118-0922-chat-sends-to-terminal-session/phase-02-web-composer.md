# Phase 2: Web: bỏ chế độ chỉ xem

Tier: S · Phụ thuộc: phase 1 (cờ `chat_takes_terminal`) · Trạng thái: xong 18/11/2026

## Sửa
- `apps/web/src/machines/session-chat.tsx`: `canSend` chỉ chặn bởi `held` khi máy không có cờ.
- `apps/web/src/machines/session-mode.tsx` `TerminalHeldBar`: với cờ, đổi thành dòng thông tin nhỏ "Phiên đang mở trong
  terminal. Gửi tin ở đây sẽ chuyển phiên sang Trò chuyện." kèm "Mở terminal"; không còn "Ở đây chỉ xem". Máy cũ giữ
  nguyên.
- Lỗi `TERMINAL_TURN_RUNNING`: `machine-errors.ts` thêm câu "Claude đang trả lời trong terminal. Đợi xong lượt rồi gửi,
  hoặc mở terminal để dừng."; chữ trong ô soạn được giữ (đường putBack đã có).
- `terminal-dock.tsx`: phiên kết thúc vì chuyển sang Trò chuyện hiện lời riêng thay cho "Tiến trình đã thoát".
- Bản dịch vi / en / zh-CN.

## Test
- `test/machines/chat-ui.test.tsx` hoặc test phiên: máy có cờ → ô soạn mở khi terminal giữ; máy cũ → khoá như trước;
  lỗi bận → hiện câu, chữ còn.
- `pnpm render-check` kịch bản phiên terminal giữ (thêm nếu chưa có).

## Đã làm
- Ô soạn tin mở khi máy có cờ; thanh trên ô soạn: "Phiên đang mở bằng Claude Code trong terminal. Gửi tin ở đây sẽ
  chuyển phiên sang Trò chuyện." (đang chạy lượt: "Gửi tin ở đây được khi lượt xong."), chỉ còn nút "Mở terminal".
- Bị từ chối vì terminal bận: câu riêng thay cho "Không gửi được", chữ và tệp trả lại ô soạn.
- Tab terminal: AI kết thúc rồi có lượt chạy ở Trò chuyện → "Phiên đã chuyển sang Trò chuyện." + "Về Trò chuyện", giữ
  sau khi lượt xong.
- Test: terminal-ui 63 (3 mới), cả bộ web 1721 đạt; kịch bản chụp `machine-held` 0 lỗi.
