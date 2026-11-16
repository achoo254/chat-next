# Nghiệm thu bản web (R0–R6)

Tài liệu cho người nghiệm thu: mở đâu, thử gì, kết quả đúng trông thế nào, giới hạn đã biết và cách gửi phản hồi. Thử trên prod, không cần cài gì.

## Mở ở đâu

| Thứ | Địa chỉ |
|---|---|
| App chat | https://chat.hoandat.com |
| Developer Console | Cài đặt › Developer Console (https://chat.hoandat.com/console) |
| Tài liệu Bot API | [`docs/bot-api/README.md`](bot-api/README.md) |
| Mini App mẫu | https://achoo254.github.io/chat-next/miniapp-demo/ |

Đăng nhập bằng tài khoản hoandat.com (Google, GitHub hoặc Apple qua trang đăng nhập hoandat.com). Trình duyệt: Chrome, Edge, Safari, Firefox bản mới; điện thoại dùng trình duyệt hoặc cài thành app (Cài đặt › Cài ứng dụng). Nên thử ít nhất hai tài khoản để nhắn qua lại.

## Kịch bản kiểm

Cột "Kết quả" để người nghiệm thu ghi Đạt / Không đạt kèm ảnh chụp.

### Tài khoản và cài đặt

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| A1 | Đăng nhập lần đầu | Vào app; có "Cloud của tôi" ghim đầu danh sách và chat với bot Trợ lý | |
| A2 | Cài đặt › Hồ sơ: đổi tên hiển thị, username, ảnh đại diện (cắt ảnh) | Lưu được; người khác thấy theo luật riêng tư | |
| A3 | Cài đặt › Quyền riêng tư: đổi "Ai thấy ảnh đại diện", "Trạng thái hoạt động" | Người khác thấy đúng theo lựa chọn | |
| A4 | Cài đặt › Tài khoản: bấm "Quản lý nơi đang đăng nhập", đăng xuất một thiết bị khác ở trang tài khoản của IdP; rồi bấm "Đăng xuất" trong app trên một thiết bị | Mở `auth.hoandat.com/account#account-sessions` ở tab mới; thiết bị kia bị đăng xuất; thiết bị vừa đăng xuất biến khỏi "Nơi đang đăng nhập" | |
| A5 | Cài đặt › Thông báo: bật thông báo khi đã đóng app | Đóng tab, nhờ người khác nhắn: có thông báo | |
| A6 | Cài đặt › Tài khoản: xuất dữ liệu | Tải được tệp dữ liệu của mình | |

### Nhắn tin

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| B1 | Tìm người theo username, nhắn tin 1-1 | Tin tới ngay, có dấu đã gửi/đã xem | |
| B2 | Trả lời, sửa, xoá, chuyển tiếp, thả cảm xúc, ghim tin | Hai bên thấy cùng lúc | |
| B3 | Tạo nhóm có ảnh, mời bằng link mời | Người nhận link vào được nhóm | |
| B4 | Nhóm: phân quyền phó nhóm, cấm thành viên, bật chủ đề | Quyền áp đúng | |
| B5 | Tạo kênh, đăng bài | Người đăng ký đọc được, không trả lời được | |
| B6 | Gửi ảnh, album, video, file, ghi âm; tạm dừng rồi tiếp tục tải lên | Xem được trong trình xem; metadata vị trí bị xoá | |
| B7 | Tắt mạng, soạn và gửi tin, bật lại | Tin xếp hàng rồi tự gửi theo thứ tự | |
| B8 | Tìm "chuc mung" (không dấu) | Ra cả tin "chúc mừng" | |
| B9 | Chặn một người, báo cáo một tin | Người bị chặn không nhắn được; báo cáo vào hàng đợi kiểm duyệt | |

### Bot và Mini App

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| C1 | Developer Console › Tạo bot, cấp token | Có token (chỉ hiện một lần) | |
| C2 | Chạy bot ví dụ `echo` trong SDK TS, Python hoặc Go ([`sdk/`](../sdk)) với token đó | Bot trả lời trong 10 phút từ lúc bắt đầu | |
| C3 | Thêm bot vào nhóm, dùng menu lệnh `/` | Bot nhận lệnh, trả lời có nút bấm | |
| C4 | Console › Mini App: đặt URL https://achoo254.github.io/chat-next/miniapp-demo/, mở chat với bot, bấm "Mở app" | Mini App mở ở cột phải (điện thoại: toàn màn hình), đầu khung hiện `achoo254.github.io` | |
| C5 | Trong Mini App: Gửi dữ liệu cho bot, Xin quyền nhắn tin, Mở link ngoài, menu ⋯ › Tải lại / Thu nhỏ | Mỗi việc đều hỏi lại người dùng khi cần; thu nhỏ rồi mở lại giữ nguyên trang | |
| C6 | Nhóm › Webhook tích hợp: tạo webhook, gửi cảnh báo Grafana/GitLab mẫu | Cảnh báo vào nhóm, cập nhật tại chỗ khi resolved | |

### Vận hành

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| D1 | Tài khoản vận hành: Kiểm duyệt › Hàng đợi báo cáo, Góp ý | Thấy báo cáo và góp ý, xử lý được | |
| D2 | Nhóm "Vận hành chat" | Nhận cảnh báo vận hành (watchdog) và góp ý, báo cáo mới | |

### Văn phòng AI

Cần một máy chạy `tunelo` 3.6.0 trở lên và một phiên Claude do app mở (trừ E18, E19). Mở AI Agent › một phiên › tab "Văn phòng". Nhân vật, phòng và
tín hiệu: [ADR 0018](adr/0018-office-view-babylon-normalized-agent-stream.md); tầng sinh hoạt, lịch và trò chuyện: [ADR 0019](adr/0019-office-living-floor-and-resident-talks.md); bảng phân phòng: [`office-wire.md`](office-wire.md) mục 4.

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| E1 | Mở tab Văn phòng của một phiên | Đầu phiên có "Trò chuyện \| Terminal \| Văn phòng" (Terminal khi AI hỗ trợ); văn phòng 3D hiện tầng 1 với Giám đốc; lần sau mở phiên vẫn ở tab Văn phòng | Đạt 16/11/2026 (prod, Chrome desktop, WebGPU) |
| E2 | Bấm T2, T3 trên thanh tầng; để bật "Tự theo" và cho AI chạy việc ở tầng khác | Chuyển tầng có hiệu ứng thang máy; tầng có người làm việc có chấm; Tự theo chuyển tới tầng vừa có việc, không nhảy liên tục, và ngừng tự theo một lúc sau khi tự bấm tầng; tắt Tự theo thì nhớ trên thiết bị | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E3 | Sảnh (T1): gửi một tin cho AI; cho AI gửi tin qua MCP `tunelo` | Thư bay vào sảnh khi lượt mới bắt đầu; lúc AI gửi tin qua MCP `tunelo` thì người gửi đứng ở sảnh; nhân viên mới bước vào từ cửa sảnh; bảng tin có Nhân viên hôm nay, Việc xong, Thời gian phiên | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E4 | Phòng Giám đốc (T1): hỏi một câu AI trả lời không cần tool | Giám đốc ở phòng mình, tư thế suy nghĩ; phiên rảnh thì "Rảnh" | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E5 | Phòng làm việc chung (T1): nhờ AI sửa một tệp | Người làm đi tới bàn gõ phím, màn hình bàn sáng, bong bóng hiện tên tệp (không thư mục) | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E6 | Phòng máy chủ (T1): nhờ AI chạy `ls`; rồi một lệnh chạy nền | `ls` ở phòng máy chủ, bong bóng chỉ hiện tên lệnh; lệnh nền thành một "Máy" ở phòng máy chủ, đèn rack nháy, máy rời khi lệnh nền xong | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E7 | Phòng họp (T1): nhờ AI chạy subagent lồng (subagent gọi subagent) hoặc workflow; hoặc hơn 8 subagent (điện thoại: 6) | Subagent lồng ngồi phòng họp; người không còn bàn ngồi phòng họp kèm nhãn "+N" | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E8 | Pantry (T1): để phiên rảnh | Sau một lúc rảnh, người không có việc uống cà phê ở pantry, tán gẫu ở sofa hoặc ngáp ở bàn; Giám đốc đi tuần; không ai đang làm việc bị kéo vào pantry | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E9 | Phòng Kế hoạch (T2): nhờ AI lập danh sách việc (todo) | Người đi tới phòng Kế hoạch; bảng "Việc cần làm" chỉ có số Chờ / Đang làm / Xong, không có chữ của mục | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E10 | Thư viện (T2): nhờ AI đọc tệp, tìm trong mã, đọc một trang web | Người đi thang máy lên Thư viện; bong bóng hiện tên tệp hoặc tên miền, tìm kiếm thì không hiện câu tìm | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E11 | Bưu phòng (T2): nhờ AI chạy `git status`; gọi một tool MCP ngoài | Người tới Bưu phòng; bong bóng MCP chỉ hiện tên tool, không có tên server | Đạt 16/11/2026 (e2e máy giả; prod: chuỗi đánh dấu trong lệnh không tới web) |
| E12 | Phòng Bảo vệ (T3): ở chế độ quyền hỏi duyệt, nhờ AI chạy lệnh cần duyệt | Người có tool cần duyệt đứng ở Bảo vệ, trạng thái "Chờ duyệt"; Chủ tịch (bạn) đứng ở sảnh | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E13 | Phòng Kiểm toán (T3): xong một lượt | Bảng Chi phí có Token vào, Token ra và Chi phí ước tính; phiên chưa có lượt nào kết thúc hiện "Chưa có số liệu", không hiện số 0 | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E14 | Phòng QA/ISO (T3): nhờ AI chạy `pnpm test` (một lần qua, một lần trượt) | Người tới QA; bảng Kiểm thử đếm Qua / Trượt; qua thì ăn mừng, trượt thì bốc khói | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E15 | Nhờ AI chạy một subagent (ví dụ scout) tới khi xong, rồi để phiên rảnh hơn 10 phút | Nhân viên có tên và phụ kiện theo loại agent, vào từ cửa sảnh, đi qua cửa và thang máy tới phòng của việc; xong thì tới phòng Giám đốc nộp hồ sơ rồi về bàn; rảnh lâu thì không ai về, không còn "Tan ca": nhân viên ở lại làm cư dân và sống theo lịch (E25) | Chưa chạy lại sau khi bỏ tan ca (16/11/2026: e2e máy giả `office.e2e.ts` cho mọi subagent rời đi, cả 11 người vẫn ở toà nhà) |
| E16 | Ở E12: lần đầu Cho phép, lần sau Từ chối | Cho phép: người quay lại việc; Từ chối: "Bị chặn ở cửa", lắc đầu rồi quay về | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E17 | Tắt mạng của máy hơn 30 giây, rồi bật lại | Báo "Mất điện", người đứng hình, phủ xám; nối lại thì "Đang cập nhật văn phòng…" rồi sáng đèn, trạng thái đúng với phiên | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E18 | Mở phiên trên máy chạy `tunelo` cũ hơn 3.6.0; mở thẳng đường dẫn `…/office` của phiên đó | Không có tab Văn phòng; đường dẫn thẳng hiện "Cập nhật tunelo trên máy (3.6.0 trở lên)…", không lỗi | Chưa chạy |
| E19 | Mở tab Văn phòng của một phiên Antigravity | Chỉ có Giám đốc (vẫn đi tới phòng theo tool) và dòng "AI này chưa báo cáo nhân viên: chỉ có Giám đốc."; bảng Chi phí chỉ có token | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E20 | Mở văn phòng với `?office3d=off` trên địa chỉ (hoặc trình duyệt tắt tăng tốc phần cứng) | Bản 2D: ảnh dựng sẵn của từng tầng, đủ 4 tầng qua thanh tầng, chấm trạng thái và nhãn tên đặt đúng bàn | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E21 | Điện thoại dọc (trình duyệt và app): mở văn phòng, kéo, chuyển tầng | Mở vào khu 6 bàn của tầng 1, kéo dời khung trong tầng; đủ 4 tầng; người thứ 7 trở đi vào phòng họp kèm "+N" | Chưa chạy |
| E22 | Xem lúc ban ngày, chiều tối, ban đêm (đổi giờ máy xem) | Ngày sáng; chiều chuyển dần sang đêm; đêm có đèn bàn và màn hình sáng, ánh sáng ấm; ánh sáng chỉ theo giờ, không còn tối đèn vì phiên rảnh | Đạt 16/11/2026 cho ánh sáng theo giờ (Mac, Chrome: ngày; 18 giờ 05 ra chiều tối, 18 giờ 12 ra đêm); bỏ tan ca chưa xem lại trên máy thật |
| E23 | Lăn chuột hoặc chụm hai ngón; chuột phải kéo, Shift kéo hoặc hai ngón kéo ngang | Zoom trong giới hạn; xoay nhẹ trong giới hạn góc rồi tự về góc mặc định sau vài giây không chạm | Đạt 16/11/2026 (e2e `office.e2e.ts`: zoom dừng ở 0,8 và 3,2; chuột phải kéo và Shift kéo xoay tối đa 0,45 rad; Mac: xoay trượt về 0 khi để yên) |
| E24 | Bấm nút "Âm thanh" | Mặc định tắt; bật thì nghe chuông thang máy, gõ phím, ăn mừng, chuông khi chờ duyệt; lựa chọn nhớ trên thiết bị | Đạt 16/11/2026 (Mac, Chrome: mặc định tắt, 0 âm trong 8 giây; bật thì tải 5 tệp và phát 6 âm trong 16 giây; lựa chọn được nhớ; chưa nghe bằng tai) |
| E25 | Để phiên rảnh rồi xem văn phòng lúc 23:30, 20:00, 12:30, 10:00 (đổi giờ máy xem) | Tầng 4 "sinh hoạt" có ở thanh tầng (T4) với ký túc, phòng gym, phòng giải trí và nhà ăn; 23:00–6:00 mọi người (cả Giám đốc) nằm ngủ trên giường ký túc, giường đầy thì ngủ gật ở sofa; 6:00–7:00 người thích tập ra gym; bữa sáng, trưa ở bàn ăn; 17:30–19:00 gym hoặc giải trí; 19:00–23:00 tivi, bàn ăn, thỉnh thoảng nhảy; giờ hành chính ở tầng làm việc; mỗi chỗ một người; mỗi người lệch giờ vài phút; Tự theo tới tầng đông người khi không ai làm việc; có việc thật thì người đang ngủ ngồi dậy rồi đi làm ngay | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`: 23:30 Giám đốc nằm giường, đủ 8 giường mỗi giường một người, theo tới T4; sáng hôm sau về tầng làm việc; test `office-life-schedule.test.ts`). Chưa xem trên máy thật |
| E26 | Ở E25 lúc 20:00, xem vài phút | Hai người rảnh gần nhau thỉnh thoảng đi tới nhau, quay mặt, nói 2–4 câu tiếng Việt luân phiên trong bong bóng (cả 3D và 2D); câu nói theo việc thật của phiên (vừa làm gì, mất bao lâu, kiểm thử đạt hay trượt, chờ duyệt bao lâu, giờ ăn, gym, tivi, chúc ngủ ngon) và không lộ lệnh, đường dẫn hay tên tệp; không bắt chuyện người đang ngủ hay đang làm; bị gọi đi làm thì bong bóng tắt | Đạt 16/11/2026 cho logic (test `office-conversations.test.ts`: hơn 120 câu, không còn chỗ trống, không từ nội bộ, tất định, tối đa 2 cuộc mỗi tầng, không ai nói 2 lần trong 3 phút). Chưa xem trên máy thật |
| E27 | Cho AI chạy một lệnh treo (ví dụ `sleep 600`) không có sự kiện nào khác của người đó | Sau 2 phút "Chạy lâu" có đồng hồ cát; sau 5 phút im lặng người đó ngủ gật tại chỗ làm (không lên giường), bong bóng "Zzz", nhãn "Kẹt N phút"; có sự kiện mới thì tỉnh ngay; cùng hiện ở 3D và 2D | Đạt 16/11/2026 cho logic (test `office-stuck.test.ts`: chạy lâu mà vẫn có sự kiện thì không ngủ gật; im lặng 5 phút thì ngủ gật; có sự kiện thì tỉnh). Không có nhánh "ngủ gật ngắn sau timeout": dữ liệu web nhận không phân biệt tool kết thúc vì timeout ([ADR 0019](adr/0019-office-living-floor-and-resident-talks.md)) |
| E28 | Mở văn phòng, cho AI chạy vài subagent tới khi họ rời đi (hoặc chờ phiên rảnh hơn 10 phút), rồi tải lại trang | Mọi người đã làm trong phiên vẫn ở toà nhà với đúng tên và số thứ tự như trước khi tải lại (cần agent có trường cư dân; agent cũ chỉ còn người đang có mặt) | Đạt 16/11/2026 cho logic (test `office-services-residents.test.ts`: tải lại cho cùng khoá nhân viên, cư dân, "nhân viên hôm nay" như thiết bị xem từ đầu; test `office-tracker.test.ts` phía agent). Chưa xem trên máy thật |
| E29 | Cho AI chạy nền `pnpm dev --port 5173`, `gh run watch`, `pnpm build` | Mỗi lệnh nền là một robot ở phòng máy chủ, màu theo nhóm, đèn ăng-ten nháy; nhãn "Máy chủ dev", bong bóng "Máy chủ dev · cổng 5173 · N phút", "Theo dõi CI · N phút", "Build · N phút"; build im lặng quá 7 phút thì màn hình mờ, mắt tắt, "Zzz"; máy chủ dev chạy lâu không bao giờ "Zzz"; bản 2D chấm vuông có ăng-ten; không lộ chữ của lệnh | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`: robot và nhãn máy chủ dev cổng 5173; test `office-service-kind.test.ts`, `office-services-residents.test.ts`). Chưa xem trên máy thật |
| E30 | Cho AI chạy subagent nền (`run_in_background`), để agent chính hết lượt | Nhân viên đó vẫn làm việc tới khi AI báo xong, không đi xem tivi; mọi người không rời văn phòng khi còn subagent nền | Đạt 16/11/2026 cho logic (test `office-tracker.test.ts` "subagents in the background", `office-reading.test.ts`). Chưa xem trên máy thật |
| E31 | Đang ở tab Văn phòng (hoặc Terminal) của một phiên, chọn phiên khác ở danh sách; rồi rời tab Văn phòng và quay lại | Phiên kia mở cùng chế độ đã chọn (máy chạy tunelo cũ không có Văn phòng thì mở như trước); quay lại văn phòng thì mọi người hiện ngay ở chỗ, không ai đi từ cửa vào | Đạt 16/11/2026 (test `office-view.test.tsx`; e2e `office.e2e.ts` "opening the office again") |

### Cố vấn

Cần một máy chạy `tunelo` có Cố vấn (3.13.0 trở lên), một phiên Claude do app mở, và khoá TypeSafe thật dán ở Cài đặt › Cố vấn. Quyết định và
giới hạn: [ADR 0020](adr/0020-advisor-mascot-jev.md); dữ liệu gửi đi: [`privacy/data-inventory.md`](privacy/data-inventory.md) mục "Cố vấn". Kịch bản
F1 làm sau khi nút gộp bằng rebase ở khung Quản lý mã nguồn đã phát hành. Ghi độ trễ mỗi lần gọi Jev và từ lúc hỏi tới lúc có bong bóng vào báo
cáo nghiệm thu.

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| F1 | Khung Quản lý mã nguồn: gây một lỗi git mà nút rebase không xử lý (push lên nhánh được bảo vệ, hoặc thiếu quyền); copy dòng lỗi, mở mascot, bấm "Đính kèm đoạn vừa copy", hỏi | Chip ghi khung, thư mục, nhánh; Cố vấn chạy trong đúng thư mục, đọc lỗi đầy đủ (đã làm sạch), trả lời bằng bong bóng có nguyên nhân, phương án cao nhất kèm %; "Gửi sang phiên" điền cách sửa vào ô nhập của phiên làm việc, không tự gửi | Chưa chạy |
| F2 | Như F1 với lỗi push khi nhánh lệch với remote | Cố vấn giải thích đúng và chỉ tới nút gộp bằng rebase của khung Quản lý mã nguồn | Chưa chạy |
| F3 | Hai thiết bị hỏi cùng thư mục cùng lúc; bấm Dừng ở một bên | Mỗi bên nhận đúng câu trả lời của mình; Dừng chỉ huỷ câu của bên bấm; thiết bị kia chỉ thấy chấm trên mascot | Chưa chạy |
| F4 | Khoá điện thoại khi Cố vấn đang nghĩ, chờ, mở lại app | Có Web Push "Cố vấn đã trả lời" chỉ ghi tên máy; mở lại thấy câu trả lời | Chưa chạy |
| F5 | Mở thẳng `/chat` (tải lạnh) rồi hỏi Cố vấn | Mascot có mặt; "đang kết nối" rồi trả lời | Chưa chạy |
| F6 | Copy bot token ở Developer Console, URL webhook một lần, hoặc bí mật đăng nhập; rồi mở mascot | Không gợi ý đính kèm, không có trong "Các lần copy gần đây" | Chưa chạy |
| F7 | Hỏi Cố vấn điều khiến AI muốn chạy Bash, sửa tệp, đọc `.env` hay tìm nội dung tệp bằng Grep | AI bị từ chối ngay (tìm nội dung đi qua `advisor_grep`); không thẻ duyệt, không huy hiệu "cần bạn"; phiên Cố vấn không hiện trong danh sách phiên, thư mục gần đây, văn phòng hay thống kê | Chưa chạy |
| F8 | Hỏi không đính kèm từ màn chat thường | Hỏi máy chọn lần cuối, chạy trong thư mục nháp (ngoài thư mục cấu hình tunelo); copy trong chat thường không rời thiết bị khi chưa đính (xem frame gửi đi), khi đính chỉ ghi "một tin nhắn chat" | Chưa chạy |
| F9 | Menu ⋯ của mascot › "Tự theo dõi phiên này" trên một phiên Claude, ba lượt | Mỗi lượt xong có thẻ "Cố vấn nhận định" và một dòng ngắn cạnh mascot; AI làm theo khi chắc chắn, hỏi lại khi phân vân; chip mờ khi lượt chạy; không thẻ duyệt cho `advisor_weigh`; `/compact` không bị chèn chỉ dẫn; tắt giữa phiên thì lượt sau AI không gọi | Chưa chạy |
| F10 | Ở F9, mở tab Văn phòng | Cố vấn ngồi ghế đầu bàn Phòng họp, tên và ngoại hình theo Cài đặt › Cố vấn; khi AI hỏi thì người hỏi đứng cạnh, bong bóng "Đang cân nhắc" rồi câu trả lời; tải lại vẫn đúng | Chưa chạy |
| F11 | Dừng lượt khi Cố vấn đang được hỏi; xoá khoá từ thiết bị khác; để Jev quá 8 giây | Thẻ hoặc bong bóng ghi lý do, không chip, không dòng "Lượt này AI chưa hỏi Cố vấn"; xoá khoá thì mọi thiết bị thấy "Máy chưa có khoá Cố vấn" ngay | Chưa chạy |
| F12 | Tìm khoá: log của tunelo, transcript, frame lỗi, env của CLI (`ps -E`); nhờ AI của phiên làm việc chạy `tunelo advisor set-key` qua pipe hoặc đọc Keychain của tunelo bằng `security … -w` | Không thấy khoá ở đâu; các lệnh đó bị coi là nhạy cảm (thẻ duyệt) hoặc bị từ chối; thiết bị chỉ thấy dấu vân tay | Chưa chạy |
| F13 | Kéo mascot quanh màn, thả gần mép; mở khung Quản lý mã nguồn, terminal, ô nhập; mở bàn phím điện thoại | Hít vào mép gần nhất, nhớ vị trí trên thiết bị; không che header, nút chính hay ô nhập; trên điện thoại bong bóng là sheet đáy | Chưa chạy |
| F14 | Mở web mới với máy chạy tunelo cũ; mở web cũ với máy chạy tunelo mới đang bật chế độ tự động | Web mới: mascot ngủ, "Máy cần cập nhật tunelo để dùng Cố vấn."; web cũ: `advisor_weigh` là thẻ tool thường, không nhân viên lạ trong văn phòng, không phiên Cố vấn lạ trong danh sách | Chưa chạy |
| F15 | Cài đặt › Cố vấn: đổi tên, ngoại hình, giọng văn trên một thiết bị | Mascot, bong bóng, thẻ và văn phòng trên mọi thiết bị đổi theo; câu trả lời sau đổi giọng | Chưa chạy |

## Giới hạn đã biết

- App iOS/Android chưa lên store (iOS mới có TestFlight nội bộ, xem [`mobile-app.md`](mobile-app.md)); trên điện thoại dùng bản web hoặc cài thành app từ trình duyệt. Không có app desktop riêng (huỷ R8 ngày 20/10/2026: desktop = PWA).
- Server chưa có ffmpeg: video, audio do bot gửi chưa có ảnh xem trước, sóng âm và thời lượng.
- Ở bề rộng 761–1100 px, cột thông tin và Mini App phủ lên phần phải khung chat thay vì xếp thành cột riêng.
- Phiên Cố vấn chưa chạy với Antigravity (chờ thử tay xác nhận agy xin quyền từng tool); chế độ tự động của phiên Antigravity vẫn dùng được. Ô skin và phụ kiện riêng của 4 ngoại hình Cố vấn trong văn phòng 3D chưa có: Cố vấn dùng ô skin tạm, chỉ ngoại hình cú có kính.
- Mỗi process phục vụ tối đa 1000 người online cùng lúc (giới hạn đã đo trên máy hiện tại); vượt thì người sau chờ "Đang kết nối…".

## Gửi phản hồi

- Trong app: Cài đặt › Góp ý, hoặc nhắn cho bot Trợ lý.
- Lỗi hiển thị: chụp màn hình kèm cỡ cửa sổ (hoặc tên máy điện thoại) và thời điểm.
- Người vận hành xem tại Kiểm duyệt › Góp ý và trong nhóm "Vận hành chat".
