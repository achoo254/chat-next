# Phase 3: Docs, phát hành tunelo, nghiệm thu máy thật

Tier: S · Phụ thuộc: phase 1, 2 · Trạng thái: xong 18/11/2026

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

## Kết quả
- `docs/terminal-wire.md` cập nhật; tag `tunelo-v3.18.0` phát hành đủ 5 nền tảng (ký + notarize macOS); script cài ghim
  3.18.0; Mac mini `tunelo update` lên 3.18.0; web deploy ở `fa9c1cc8`.
- Nghiệm thu trên chat.hoandat.com với Mac mini:
  - Terminal trả lời "TERMINAL", rảnh; gửi từ Trò chuyện → chạy, trả lời "CHAT", thanh "đang mở trong terminal" biến mất.
  - Mở lại Terminal → CLI resume đúng phiên, thấy cả hai lượt.
  - Terminal đang viết (lượt dài), gửi từ Trò chuyện → từ chối với câu mới, chữ còn trong ô soạn, thanh đổi sang "đang
    chạy một lượt", terminal chạy tiếp.
- Chưa thấy trên máy thật: câu "Phiên đã chuyển sang Trò chuyện" trong tab terminal (chỉ hiện khi thiết bị khác đang mở
  tab đó lúc chuyển; có test tự động).
- Thanh trên ô soạn đổi sang "đang chạy một lượt" chậm vài giây sau khi lượt trong terminal bắt đầu (trạng thái bận được
  dò định kỳ); gửi trong khoảng đó vẫn bị máy từ chối đúng.
