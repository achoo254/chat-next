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
tín hiệu: [ADR 0018](adr/0018-office-view-babylon-normalized-agent-stream.md); bảng phân phòng: [`office-wire.md`](office-wire.md) mục 4.

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
| E15 | Nhờ AI chạy một subagent (ví dụ scout) tới khi xong, rồi để phiên rảnh hơn 10 phút | Nhân viên có tên và phụ kiện theo loại agent, vào từ cửa sảnh, đi qua cửa và thang máy tới phòng của việc; xong thì tới phòng Giám đốc nộp hồ sơ rồi về bàn; rảnh hơn 10 phút thì về, toà nhà "Tan ca" tối đèn | Đạt một phần 16/11/2026 (prod: subagent vào và xong việc; chưa chờ 10 phút tan ca) |
| E16 | Ở E12: lần đầu Cho phép, lần sau Từ chối | Cho phép: người quay lại việc; Từ chối: "Bị chặn ở cửa", lắc đầu rồi quay về | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E17 | Tắt mạng của máy hơn 30 giây, rồi bật lại | Báo "Mất điện", người đứng hình, phủ xám; nối lại thì "Đang cập nhật văn phòng…" rồi sáng đèn, trạng thái đúng với phiên | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E18 | Mở phiên trên máy chạy `tunelo` cũ hơn 3.6.0; mở thẳng đường dẫn `…/office` của phiên đó | Không có tab Văn phòng; đường dẫn thẳng hiện "Cập nhật tunelo trên máy (3.6.0 trở lên)…", không lỗi | Chưa chạy |
| E19 | Mở tab Văn phòng của một phiên Antigravity | Chỉ có Giám đốc (vẫn đi tới phòng theo tool) và dòng "AI này chưa báo cáo nhân viên: chỉ có Giám đốc."; bảng Chi phí chỉ có token | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E20 | Mở văn phòng với `?office3d=off` trên địa chỉ (hoặc trình duyệt tắt tăng tốc phần cứng) | Bản 2D: ảnh dựng sẵn của từng tầng, đủ 3 tầng qua thanh tầng, chấm trạng thái và nhãn tên đặt đúng bàn | Đạt 16/11/2026 (e2e máy giả `office.e2e.ts`) |
| E21 | Điện thoại dọc (trình duyệt và app): mở văn phòng, kéo, chuyển tầng | Mở vào khu 6 bàn của tầng 1, kéo dời khung trong tầng; đủ 3 tầng; người thứ 7 trở đi vào phòng họp kèm "+N" | Chưa chạy |
| E22 | Xem lúc ban ngày, chiều tối, ban đêm (đổi giờ máy xem), và lúc tan ca | Ngày sáng; chiều chuyển dần sang đêm; đêm có đèn bàn và màn hình sáng, ánh sáng ấm; tan ca tối đèn dù giờ nào | Đạt một phần 16/11/2026 (ngày và đêm trên Mac; chưa xem chiều tối, tan ca) |
| E23 | Lăn chuột hoặc chụm hai ngón; chuột phải kéo, Shift kéo hoặc hai ngón kéo ngang | Zoom trong giới hạn; xoay nhẹ trong giới hạn góc rồi tự về góc mặc định sau vài giây không chạm | Chưa chạy |
| E24 | Bấm nút "Âm thanh" | Mặc định tắt; bật thì nghe chuông thang máy, gõ phím, ăn mừng, chuông khi chờ duyệt; lựa chọn nhớ trên thiết bị | Chưa chạy |

## Giới hạn đã biết

- App iOS/Android chưa lên store (iOS mới có TestFlight nội bộ, xem [`mobile-app.md`](mobile-app.md)); trên điện thoại dùng bản web hoặc cài thành app từ trình duyệt. Không có app desktop riêng (huỷ R8 ngày 20/10/2026: desktop = PWA).
- Server chưa có ffmpeg: video, audio do bot gửi chưa có ảnh xem trước, sóng âm và thời lượng.
- Ở bề rộng 761–1100 px, cột thông tin và Mini App phủ lên phần phải khung chat thay vì xếp thành cột riêng.
- Mỗi process phục vụ tối đa 1000 người online cùng lúc (giới hạn đã đo trên máy hiện tại); vượt thì người sau chờ "Đang kết nối…".

## Gửi phản hồi

- Trong app: Cài đặt › Góp ý, hoặc nhắn cho bot Trợ lý.
- Lỗi hiển thị: chụp màn hình kèm cỡ cửa sổ (hoặc tên máy điện thoại) và thời điểm.
- Người vận hành xem tại Kiểm duyệt › Góp ý và trong nhóm "Vận hành chat".
