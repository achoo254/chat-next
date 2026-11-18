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

- Danh sách cư dân sống trong bộ nhớ của trang; từ bổ sung dưới đây, ảnh chụp mang thêm người đã rời nên tải lại trang vẫn giữ cư dân (agent cũ: chỉ còn
  người đang có mặt như trước).
- Người xem ở múi giờ khác thấy lịch khác: chủ ý, giống ánh sáng.
- Tầng 4 thêm vào thanh tầng (T4); "Tự theo" khi không ai làm việc thì tới tầng đông người nhất.

## Bổ sung (16/11/2026): cư dân qua lần tải lại, nhãn và robot cho dịch vụ nền

- **Cư dân qua lần tải lại**: `OfficeState.residents` (proto chỉ thêm) mang tối đa 32 nhân viên đã rời trong phiên, chỉ các trường `OfficeActor` vốn đã
  gửi. Web mở văn phòng mới thì tuyển lại họ theo thứ tự vào rồi cho thành cư dân ngoài giờ, nên tên và số thứ tự như thiết bị xem từ đầu
  ([`office-wire.md`](../office-wire.md) mục 3).
- **Nhãn dịch vụ**: agent phân loại lệnh nền ngay trên máy (cùng phép đọc lệnh với phân phòng) thành 7 nhóm, kèm cổng ghi trên dòng lệnh và lúc chạy
  (`OfficeActor.service`); chỉ enum, số cổng và thời điểm rời máy. Web gọi máy theo nhóm ("Máy chủ dev") với bong bóng "Máy chủ dev · cổng 5173 · 12 phút".
  Máy chủ dev, theo dõi test và cơ sở dữ liệu chạy tới khi bị dừng nên không bao giờ "Chạy lâu" hay ngủ gật; build, CI, git, script vẫn theo luật kẹt 5 phút.
- **Robot**: máy được vẽ bằng robot đồ chơi (`serviceRobot` của tệp tài sản), thân theo màu nhóm (`SERVICE_COLORS`), đèn ăng-ten nhấp nháy khi chạy, màn hình
  mờ và mắt tắt khi ngủ gật; thiếu tệp thì vẫn là người. Bản 2D: chấm vuông có ăng-ten theo màu nhóm.
- **Subagent chạy nền**: xong hẳn khi AI báo tác vụ nền kết thúc hoặc bản ghi báo `finished`; chỉ "coi như xong" khi im lâu mà không còn tool mở và bộ
  đếm việc nền là 0 (bản ghi im 10 phút, hoặc không nghe gì 30 phút), và một tool mới của nó đưa nó về làm; còn subagent nền đang làm thì không ai rời văn
  phòng (trước đây `background_tasks` về 0 hay lượt kết thúc sớm làm họ "hết việc" và đi xem tivi).
- **Mở lại văn phòng**: người đã có mặt hiện ngay ở chỗ của mình; chỉ ai vào sau lúc mở tab (theo `entered_at`) mới đi vào từ cửa sảnh.
- **Người nằm theo giường**: người ngủ không nhận vai trong cuộc trò chuyện và không bị xoay (cuộc trò chuyện vốn tính lại mỗi khung từ chỗ đứng hiện tại, nên
  một người ngủ thì cuộc của cả hai kết thúc); e2e đo xương đầu của mô hình: người nằm dọc giường, đầu về phía gối, ở tâm neo.
- **Chế độ phiên**: mở một phiên từ danh sách theo chế độ chọn gần nhất trên thiết bị (nếu phiên đó có); biểu tượng trên hàng phiên vẫn theo trạng thái thật và
  trí nhớ của chính phiên đó.

## Bổ sung (18/11/2026): bỏ robot, việc của dịch vụ nền giao cho nhân sự

- **Bỏ robot**: văn phòng chỉ còn 15 người; dịch vụ nền không còn là người riêng (bỏ `serviceRobot` và tệp GLB của nó, `SERVICE_COLORS`, chấm vuông có
  ăng-ten ở bản 2D). Thay mục **Robot** ở trên. Wire không đổi: web vẫn nhận actor `MACHINE` cùng `service`.
- **Việc giao cho chức danh theo nhóm** (`serviceOwnerOf`, `apps/web/src/machines/office/office-cast.ts`): máy chủ dev, build, cơ sở dữ liệu cho Backend &
  Hạ tầng; theo dõi test cho Kiểm thử phần mềm; theo dõi CI cho Giám đốc Công nghệ; git, script, nhóm lạ hay máy không nhãn cho Lập trình viên. Người đó làm
  tại chỗ ngồi của mình, bong bóng và bảng thông tin vẫn nói dịch vụ gì, cổng, chạy bao lâu; dòng thời gian ghi vào người đó. Có subagent cùng chức danh
  đang làm thì người đó hiện việc mới nhất (dịch vụ không tính vào số "×N"). Dịch vụ không tính là "agent đang chạy", nên ngoài giờ những người khác vẫn
  nghỉ.
