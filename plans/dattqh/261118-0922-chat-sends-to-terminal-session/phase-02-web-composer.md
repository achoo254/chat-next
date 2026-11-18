# Phase 2: Web: bỏ chế độ chỉ xem

Tier: S · Phụ thuộc: phase 1 (cờ `chat_takes_terminal`)

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
