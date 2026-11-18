# Phase 3: Docs, phát hành tunelo, nghiệm thu máy thật

Tier: S · Phụ thuộc: phase 1, 2

## Docs
- `docs/terminal-wire.md` mục "Phiên AI trong terminal": thay câu "`ThreadSend` bị từ chối với
  `SESSION_OPEN_ELSEWHERE` ... Không có hai giao diện cùng ghi một phiên" bằng luật mới (gửi từ Trò chuyện lấy phiên khi
  terminal rảnh; bận thì `TERMINAL_TURN_RUNNING`; vẫn không có hai tiến trình cùng ghi một phiên).

## Phát hành
- Bump tunelo theo cách repo đang làm (`chore(agent): x.y.z`, rồi ghim script cài), deploy web sau khi bản tunelo có
  trên GitHub Releases.

## Nghiệm thu trên Mac mini thật
- Mở phiên bằng terminal, hỏi một câu, đợi xong; sang Trò chuyện gửi tin → chạy, terminal báo đã chuyển, mở lại terminal
  thấy đủ lịch sử.
- Đang chạy lượt trong terminal, gửi từ Trò chuyện → bị từ chối với câu đúng, chữ còn.
- Máy chưa cập nhật tunelo → web vẫn chỉ xem như cũ.
