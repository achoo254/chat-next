---
title: "Trò chuyện gửi được tin cho phiên đang mở trong terminal"
description: "Trò chuyện và terminal ngang nhau: gửi tin từ Trò chuyện khi terminal đang giữ phiên thì phiên chuyển sang Trò chuyện, như mở terminal lấy phiên khỏi Trò chuyện."
status: in-progress
priority: P2
tags: [agent, web, proto, terminal]
blockedBy: []
blocks: []
created: 2026-11-18
---

# Trò chuyện gửi được tin cho phiên đang mở trong terminal

Trạng thái: phase 1 xong, chờ phase 2 · Tier: L (proto + agent + web + docs + phát hành tunelo)

## Kết quả mong muốn
- Phiên AI đang mở trong terminal không còn làm màn Trò chuyện thành "chỉ xem". Ô soạn tin luôn dùng được như khi
  phiên ở Trò chuyện.
- Luật chung cho hai màn, đối xứng: **phiên đi theo nơi người dùng vừa dùng**. Mở terminal lấy phiên khỏi Trò chuyện
  (đã có); gửi tin từ Trò chuyện lấy phiên khỏi terminal (mới).
- Khi một lượt đang chạy ở nơi kia thì nơi này phải đợi, giống nhau ở hai chiều (mở terminal lúc Trò chuyện đang chạy
  đã bị từ chối `THREAD_RUNNING`).

## Hiện trạng (đã đọc code)
- `agent-core.ts` `send()`: `t.meta.terminal` có giá trị thì từ chối `SESSION_OPEN_ELSEWHERE` ("No two views write to
  one session"). Web: `canSend = online && !missing && !held`, thanh `TerminalHeldBar` nói "Ở đây chỉ xem".
- Mỗi phiên chỉ có một tiến trình Claude: Trò chuyện chạy Claude qua SDK (stream-json), terminal chạy CLI
  (`claude --resume <id>`) trong PTY của daemon `term-host`. Hai bên dùng chung transcript, Trò chuyện đọc theo
  transcript khi terminal giữ phiên (`followTerminal`).
- Đã có sẵn: `terminalIdle(threadId, quietMs)` (lượt đã xong, không có tool/hộp duyệt đang chờ, đủ yên lặng),
  `terminal-service.close(session)` (treo PTY), `endTerminal(t)` (trả phiên, đọc nốt transcript).
- Daemon không có lệnh ghi chữ vào PTY: chỉ thiết bị gõ được qua kênh E2E.

## Phương án

**B (khuyến nghị): Trò chuyện lấy lại phiên khi gửi.** Gửi tin lúc terminal đang giữ phiên và rảnh: agent đóng CLI
trong terminal, trả phiên, rồi chạy tin như mọi tin Trò chuyện (resume đúng phiên). Terminal đang chạy một lượt: từ
chối với lý do riêng, web giữ nguyên chữ đã gõ và nói đợi lượt xong (hoặc mở terminal để dừng).
- Ưu: không đụng daemon; dùng lại khối đã có; đối xứng với chiều mở terminal; hộp duyệt quyền, câu hỏi, đính kèm,
  skill, Advisor ở Trò chuyện chạy như thường vì tiến trình là của Trò chuyện.
- Nhược: CLI trong terminal bị đóng; ai đang xem tab terminal thấy "Phiên đã chuyển sang Trò chuyện", bấm mở lại là
  resume. Chữ đang gõ dở trong ô nhập của CLI (chưa Enter) mất.

**A (không khuyến nghị): gõ hộ vào terminal.** Agent ghi tin vào PTY như người gõ (bracketed paste + Enter), CLI vẫn
chạy, Trò chuyện chỉ hiện theo transcript.
- Ưu: terminal không bị đóng, hai màn cùng sống.
- Nhược: cần lệnh mới trong daemon `term-host` (đổi giao thức điều khiển, phát hành daemon). Nguy hiểm: gõ vào lúc CLI
  đang mở hộp duyệt quyền thì phím có thể thành câu trả lời (ví dụ "1" = cho phép). Hộp duyệt, câu hỏi vẫn chỉ trả lời
  được trong terminal, đính kèm phải đổi thành đường dẫn chữ, nên Trò chuyện vẫn không ngang terminal.

## Quyết định (người dùng chốt 18/11/2026)
1. Phương án B: gửi từ Trò chuyện lấy phiên khỏi terminal khi terminal rảnh.
2. Terminal đang chạy lượt hoặc chờ duyệt: từ chối, giữ chữ trong ô soạn (không xếp hàng).

## Phase
| # | Phase | Tier | Trạng thái |
|---|---|---|---|
| 1 | [Proto + agent: gửi tin lấy phiên khỏi terminal](phase-01-agent-takeover.md) | M | xong |
| 2 | [Web: bỏ chế độ chỉ xem](phase-02-web-composer.md) | S | chờ |
| 3 | [Docs, phát hành tunelo, nghiệm thu máy thật](phase-03-docs-release.md) | S | chờ |

Phase 2 phụ thuộc phase 1 (cờ capability). Phase 3 sau cùng.

## Tiêu chí nghiệm thu
- Máy bản mới, phiên đang mở trong terminal và rảnh: gõ tin ở Trò chuyện → tin chạy, terminal của phiên kết thúc với
  lời "đã chuyển sang Trò chuyện", lịch sử liền mạch; mở lại terminal resume đúng phiên.
- Terminal đang chạy lượt hoặc đang chờ duyệt: gửi từ Trò chuyện bị từ chối với lời rõ ràng, chữ còn trong ô soạn.
- Máy bản cũ (không có cờ): web giữ hành vi cũ (chỉ xem + nút mở terminal).
- Test agent (rảnh/bận/chờ duyệt/đang khởi động/CLI đổi phiên bằng `/clear`) và web; typecheck, lint sạch; phát hành
  tunelo và ghim script cài.

## Ngoài phạm vi
- Advisor tự động trong terminal: đã có cờ `ProviderCapabilities.terminal_advisor`, không làm ở đây.
- Cửa sổ terminal riêng của chủ máy (ngoài tunelo) đang mở phiên: vẫn `SESSION_OPEN_ELSEWHERE` như hiện nay.
