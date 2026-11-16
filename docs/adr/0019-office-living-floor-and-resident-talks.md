# ADR 0019: Văn phòng AI sống 24/7: tầng sinh hoạt, lịch theo giờ người xem, trò chuyện viết sẵn

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-16
- Bổ sung [ADR 0018](./0018-office-view-babylon-normalized-agent-stream.md).

## Bối cảnh

Trước đây hết việc 10 phút thì toà nhà "Tan ca": nhân viên về, đèn tắt. Chủ sở hữu muốn nhân vật luôn có mặt; khi không làm việc thì sinh hoạt
đúng giờ giấc đời thực (ngủ, tập, ăn, xem tivi) và trò chuyện với nhau. Ràng buộc của ADR 0018 giữ nguyên: nội dung phiên không rời máy, web
chỉ dùng dữ kiện agent đã chuẩn hoá, không gọi model khi chạy.

## Quyết định

- **Tầng 4 sinh hoạt** (`DORM`, `GYM`, `LOUNGE` trong `office-layout.json`) là phòng riêng của web (`LIVING_ROOM_CODES`,
  `apps/web/src/machines/office/office-rooms.ts`), tách khỏi 12 phòng làm việc của enum `OfficeRoom`: không tool nào đưa ai lên tầng 4, ba tầng
  làm việc giữ nghĩa "mỗi phòng một tín hiệu". Không đổi proto hay agent.
- **Cư dân** = Giám đốc và mọi nhân viên đã vào trong phiên. Subagent rời đi thì nhân viên thành cư dân ngoài giờ (`retire`,
  `office-staff.ts`), subagent mới cùng loại đưa đúng người đó trở lại làm. Hiển thị tối đa 12 cư dân (`MAX_RESIDENTS`).
- **Lịch theo giờ máy người xem** (cùng đồng hồ với ánh sáng ngày đêm), mỗi người lệch tối đa ±20 phút và có sở thích ổn định theo khoá
  (`office-life-schedule.ts`): 23:00–6:00 ngủ, 6:00–7:00 gym hoặc ngủ thêm, 7:00–8:00 ăn sáng, 8:00–12:00 và 13:00–17:30 ở tầng làm việc,
  12:00–13:00 ăn trưa, 17:30–19:00 gym hoặc giải trí, 19:00–23:00 tivi, bàn ăn, nhảy. Việc thật (tool, chờ duyệt, subagent mới) luôn thắng lịch;
  giữa hai tool của lượt đang chạy không ai đi ngủ. Mỗi chỗ một người (`office-life-places.ts`).
- **Bỏ tan ca**: không còn `off`/"Tan ca"; ánh sáng chỉ theo giờ.
- **Trò chuyện viết sẵn** (`office-dialogue-vi.ts`, hơn 120 câu tiếng Việt theo chủ đề và giọng từng loại agent), điền bằng dữ kiện chuẩn hoá
  (`office-talk-facts.ts`, `office-work-log.ts`: loại và phòng của việc vừa xong, thời lượng, số lần, đạt hay trượt, thời gian chờ duyệt, số việc
  xong, giờ). Không bao giờ dùng lệnh, đường dẫn hay tên tệp. Ghép đôi và câu thoại tất định theo người và cửa sổ thời gian
  (`office-conversations.ts`) để mọi người xem cùng múi giờ thấy như nhau; lời thoại luôn tiếng Việt dù giao diện ngôn ngữ khác.
- **Ngủ gật khi kẹt**: tool chạy lâu mà actor im lặng 5 phút (`STUCK_MS`) thì người đó ngủ gật tại chỗ, bong bóng "Zzz", nhãn "Kẹt N phút";
  có sự kiện mới thì tỉnh. Dữ liệu hiện có không phân biệt tool kết thúc vì timeout (`OfficeActivityEnd` chỉ có `ok`), nên không có nhánh
  "ngủ gật ngắn sau timeout".

## Hệ quả

- Danh sách cư dân chỉ sống trong bộ nhớ của trang: tải lại trang sau khi agent đã cho nhân viên rời đi (agent vẫn cho mọi người trừ Giám đốc
  rời sau 10 phút rảnh, `LEAVE_AFTER_IDLE_MS` trong `apps/agent/src/office/office-tracker.ts`) thì chỉ còn Giám đốc. Giữ cư dân qua lần tải lại
  cần thêm trường vào ảnh chụp văn phòng (proto chỉ thêm, agent bản phụ): việc riêng, chưa làm.
- Người xem ở múi giờ khác thấy lịch khác: chủ ý, giống ánh sáng.
- Tầng 4 thêm vào thanh tầng (T4); "Tự theo" khi không ai làm việc thì tới tầng đông người nhất.
