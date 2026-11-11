---
title: "Cửa sổ compact cho PWA (Document Picture-in-Picture)"
status: in-progress
created: 2026-11-11
tier: M
---

# Cửa sổ compact cho PWA

## Bối cảnh

11/11/2026 đại ca nhờ phân tích kiến trúc Telegram Desktop và Zalo (REA, chỉ đọc) để học cho chat-next. Kết quả:

- Phần lớn bài học đã có: một worker giữ sync + SQLite OPFS + tìm kiếm (ADR 0007), ảnh đo và thumbnail trong worker, build 4,1 MB với 137 chỗ `import()` động.
- Bài học mới duy nhất: Zalo có chế độ cửa sổ nhỏ (compact) mở riêng cạnh việc đang làm. chat-next chưa có.
- Jev (đã đọc đúng hiện trạng code) chọn `compact_window` với xác suất 0,70, độ chắc 0,62; "không làm gì, tập trung tăng trưởng" 0,23.
- Đã hoãn: chat bí mật E2E (đại ca chốt 11/11).

## Kết quả mong muốn

Người dùng desktop bấm một nút để chat hiện trong một cửa sổ nhỏ luôn nổi trên các ứng dụng khác (Document Picture-in-Picture), vẫn nhận và gửi tin như bình thường, trong khi trang chat chính có thể ở tab nền.

## Không làm

- Không làm app desktop native (đã chốt: desktop = PWA, ADR 0007).
- Không làm E2E, không đổi sync, không đổi server, không đổi proto.
- Không làm cửa sổ compact cho iOS/Android (Capacitor).
- Không sao chép toàn bộ giao diện: chỉ một hội thoại + danh sách chat chưa đọc rút gọn.

## Hiện trạng code (đã đọc)

| Điểm | Chi tiết | Hệ quả |
|---|---|---|
| Tái dùng được | `Conversation({chatId, topicId, infoOpen})` trong `messaging/ui/conversation.tsx`, composer và message-list dùng chung | Vẽ cùng component vào cửa sổ PiP qua React portal, không viết lại giao diện |
| Dữ liệu | Một worker giữ DB và sync; UI nói chuyện qua `useChat`, `useDialog`, `useServices` | PiP cùng JS context với trang chính nên dùng chung dữ liệu, không cần sync thêm |
| Trạng thái "đã đọc" | `message-list.tsx` (`usePageVisible`) và `incoming-sound.ts` dựa vào `document.visibilityState` của trang chính | **Lỗi chính cần xử lý**: trang chính ẩn nhưng PiP đang hiện sẽ không đánh dấu đã đọc và mất âm báo |
| Sự kiện toàn cục | 58 chỗ dùng `document`/`window` trong `messaging/` và `components/` | Phải kiểm từng chỗ có chạy đúng trong tài liệu PiP không (phím tắt, focus, kích thước) |
| CSS | CSP `default-src 'self'`, CSS là file riêng (`messaging.css`, `app.css`, `fonts.css`), không inline | Cửa sổ PiP phải nạp lại các stylesheet này bằng `<link>` cùng origin |
| Hỗ trợ trình duyệt | Document PiP chỉ có trên Chromium desktop (Chrome, Edge 116+) | Safari, Firefox cần phương án dự phòng |

## Phase

| # | Việc | Tier | Trạng thái |
|---|---|---|---|
| 1 | Nền tảng PiP: module mở/đóng cửa sổ, sao chép stylesheet, portal React, nhận biết hỗ trợ trình duyệt | S | xong 2026-11-11 |
| 2 | Khung compact: một hội thoại (`Conversation`) + thanh chọn nhanh vài chat chưa đọc; nút mở trong header chat; chuỗi i18n vi/en/zh-CN | M | xong 2026-11-11; phím tắt chưa làm (xem Còn lại) |
| 3 | Tín hiệu hiển thị: đánh dấu đã đọc và âm báo theo tài liệu của cửa sổ đang vẽ; worker coi app là foreground khi compact đang mở | S | xong 2026-11-11; đếm online chưa đổi (xem Còn lại) |
| 4 | Trình duyệt không có PiP: ẩn nút | S | xong 2026-11-11 |
| 5 | Kiểm thử: unit cho module PiP và foreground; tích hợp trên core thật; kiểm tay trên Chrome và Edge | S | tự động xong 2026-11-11; kiểm tay chưa làm |

## Kết quả (2026-11-11)

Mã: `apps/web/src/compact/` (mở PiP, sao chép style, lưu kích thước), `messaging/ui/compact-window.tsx` (khung compact), `messaging/ui/surface.ts` (tài liệu mà hội thoại đang được vẽ vào), nút mở trong header của `conversation.tsx`, nguồn foreground phụ `alsoForeground` trong `packages/platform-web/src/client.ts`.

Kiểm chứng: lint `--max-warnings=0` sạch, `pnpm typecheck` sạch 10 package, `check:brand` sạch; test `apps/web` 845/845, `platform-web` 34/34, trong đó có test mới (store PiP 14, tích hợp compact 4, foreground 5). Không có thay đổi server, proto hay gói `core`.

## Nghiệm thu trên trình duyệt thật (2026-11-11)

Chạy trên Edge (Chromium) với stack dev local (`pnpm e2e --serve`, IdP giả, tài khoản thử An và Bình), Document PiP thật. Đã xác nhận: nút xuất hiện đúng chỗ; cửa sổ mở với style và theme đúng, header chỉ còn nút tìm kiếm; soạn và gửi tin từ cửa sổ nổi tới cả trang chính; cửa sổ đi theo khi trang chính đổi chat; dải chat chưa đọc hiện chip khi Bình nhắn tới, bấm chip đổi route và xóa số chưa đọc; tin tới được nhận trực tiếp trong cửa sổ; đóng và mở lại sạch; không có lỗi console.

Lỗi tìm thấy khi nghiệm thu và đã sửa:

- Kích thước cửa sổ co 45 px chiều cao mỗi lần mở lại: Chromium cấp cửa sổ nhỏ hơn kích thước yêu cầu (thanh tiêu đề) và ta lưu đúng số đã bị bớt. Nay chỉ lưu khi người dùng tự chỉnh, cộng lại phần khung; có test.
- `store.setLiveRead` chỉ có một cờ mỗi chat nên hai danh sách tin nhắn (trang chính và compact) ghi đè nhau: trang chính bị ẩn sẽ xóa cờ của compact và tin mới không được đánh dấu đã đọc. Nay mỗi cửa sổ bỏ phiếu riêng, chat được đọc trực tiếp khi bất kỳ cửa sổ nào đang xem; có test.

Chưa kiểm được trên trình duyệt thật: tình huống tab chính bị che hẳn trong khi cửa sổ nổi còn hiện (công cụ điều khiển trình duyệt không che được tab). Tình huống này được test tự động bằng cách giả `visibilityState` của trang chính: đánh dấu đã đọc, và âm báo chỉ phát một lần từ cửa sổ đang xem.

## Còn lại

- **Phím tắt mở compact:** chưa làm, hiện chỉ có nút trong header chat.
- **Kiểm tay tình huống tab chính bị che** trên Chrome/Edge thật (xem trên).
- **Đếm online (`online-count.ts`):** vẫn làm mới theo `visibilitychange` của trang chính; trang chính ẩn thì số online trong compact có thể cũ.
- **Trình xem ảnh (`ViewerLayer`):** trạng thái xem ảnh là toàn cục nên mở ảnh trong compact cũng hiện lớp phủ ở trang chính (đang bị che).
- **Thông báo hệ điều hành:** vẫn hiện khi compact đang mở và trang chính ẩn (theo quyết định 3).

## Chi tiết từng phase

### Phase 1: nền tảng PiP

- Module riêng trong `apps/web/src/` (ví dụ `compact/`), không đặt trong `packages/core`.
- `isSupported()` kiểm `"documentPictureInPicture" in window`.
- `open({width, height})` gọi `documentPictureInPicture.requestWindow`, bắt buộc từ thao tác người dùng.
- Sao chép stylesheet của trang chính sang tài liệu PiP bằng `<link rel="stylesheet">` cùng URL, không dùng `adoptedStyleSheets` hay CSS inline vì CSP.
- Đóng: nghe `pagehide` của cửa sổ PiP để dọn trạng thái; trang chính đóng thì PiP đóng theo.
- Gắn theme (sáng/tối) và `lang` của trang chính vào tài liệu PiP.
- Chỉ một cửa sổ compact tại một thời điểm.

### Phase 2: khung compact

- Nội dung: tiêu đề chat, `Conversation` đang mở, ô soạn tin; một dải rút gọn các chat chưa đọc để đổi nhanh. Không có folder rail, không info panel, không trang cài đặt.
- Mở từ header của chat đang xem (hiện chỉ khi hỗ trợ) và một phím tắt thêm vào danh sách phím tắt hiện có.
- Mở compact khi người dùng đang ở chat nào thì hiển thị đúng chat đó; đổi chat trong compact không làm đổi route của trang chính.
- Chuỗi giao diện thêm vào đủ các bộ copy hiện có; không hard-code chữ.
- Dùng component và token màu hiện có; không thêm màu mới.

### Phase 3: tín hiệu hiển thị

- Một hook dùng chung trả về "người dùng đang nhìn thấy app" = `document.visibilityState === "visible"` của trang chính **hoặc** cửa sổ compact đang mở và hiện.
- Thay vào `usePageVisible` (message-list), điều kiện tắt âm của `incoming-sound.ts`, và làm mới số người online.
- `messaging-root.tsx` lưu snapshot khi trang chính ẩn: giữ nguyên.
- Test: trang chính ẩn + compact hiện thì tin tới vẫn được đánh dấu đã đọc và vẫn có âm báo; cả hai ẩn thì như cũ.

### Phase 4: dự phòng

Trình duyệt không có Document PiP thì giữ nguyên hành vi hiện tại: không hiện nút. Có tuỳ chọn mở cửa sổ nhỏ thường (xem câu hỏi mở); cửa sổ đó là một tab khác của app nên `tab-hub` và khoá Web Locks đã sẵn xử lý nhiều tab.

### Phase 5: kiểm thử

- Vitest cho module PiP (giả lập `documentPictureInPicture`) và hook tín hiệu hiển thị.
- E2E nhiều người dùng (`pnpm e2e`) chỉ chạy màn vừa sửa, một lần trước commit.
- Kiểm tay: Chrome, Edge desktop; Safari và Firefox xác nhận nút không hiện.
- Chạy `pnpm lint && pnpm typecheck && pnpm test` đến sạch; test nặng giới hạn hai worker.

## Tiêu chí xong

- Trên Chrome/Edge desktop, một nút mở cửa sổ compact luôn nổi; gửi và nhận tin hoạt động, ảnh và tin trả lời hiển thị đúng, theme và ngôn ngữ giống trang chính.
- Trang chính ở tab nền mà compact đang hiện thì tin tới được đánh dấu đã đọc và có âm báo.
- Đóng compact không mất tin đang soạn dở của hội thoại.
- Safari và Firefox không hiện nút, không lỗi console.
- Lint, typecheck, test sạch; không thêm phụ thuộc mới.

## Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Phím tắt, focus, resize gắn vào `document` của trang chính không chạy trong PiP | Trung bình | Rà 58 chỗ dùng `document`/`window` ở Phase 2; chuyển sang tài liệu của phần tử khi cần |
| Tin trả lời bằng phím tắt hoặc menu ngữ cảnh mở lớp phủ gắn vào `document.body` của trang chính | Trung bình | Phase 2 kiểm dialog host và menu; render lớp phủ vào body của tài liệu PiP |
| Trình duyệt chỉ hỗ trợ Chromium | Thấp | Chấp nhận, ẩn nút ở nơi không hỗ trợ |
| Stylesheet đổi tên theo hash mỗi build | Thấp | Đọc danh sách `<link>` hiện tại của trang chính lúc mở PiP, không hard-code |

## Quyết định (đại ca đồng ý 11/11/2026)

1. Trình duyệt không có Document PiP: **ẩn nút**, không làm cửa sổ nhỏ thường.
2. Compact **nhớ kích thước** lần trước (`localStorage`, bọc try/catch, hiển thị đúng khi không đọc được).
3. Thông báo **dùng kênh hiện có**, không thêm kênh riêng cho compact.

## Phát hiện bổ sung khi bắt đầu làm

- Lõi sync theo dõi **một** chat đang mở (`source.openChat` trong `chat-screen.tsx`, theo route). Vì vậy compact là góc nhìn thứ hai của cùng route: đổi chat trong compact là điều hướng route của trang chính, không tạo trạng thái chat độc lập.
- `Conversation` dùng `Ui` (dialog, menu, ý định trả lời/sửa) của `ChatScreen`. Compact tạo `Ui` riêng và `DialogHost` riêng trong tài liệu PiP để lớp phủ hiện đúng cửa sổ.
- `packages/platform-web/src/client.ts` gửi cờ `foreground` cho worker theo `document.hidden` của trang chính. Compact hiện mà trang chính ẩn thì worker coi app là nền. Client đã có `onForegroundChange` làm nguồn foreground phụ; Phase 3 nối compact vào đó và sửa chỗ `onVisibility` để không ghi đè.
- Service worker ẩn thông báo đẩy khi có cửa sổ `focused` và `visible`; cửa sổ PiP không phải client của service worker nên thông báo hệ điều hành vẫn hiện khi compact đang mở. Chấp nhận theo quyết định 3.
- Nút quay lại và nút thông tin trong header `Conversation` không dùng được trong compact (ẩn qua một prop), và một chỗ dùng `document.querySelector(".convo .composer .composer-field")` toàn cục phải đổi thành tìm trong phần tử hiện tại.
