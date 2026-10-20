# ADR 0004: Định dạng văn bản tin nhắn

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14
- Huỷ 20/10/2026: desktop = PWA. Toàn hệ sinh thái không có app desktop native (Tauri); trên máy tính dùng bản web cài dạng PWA, đăng nhập bằng `chat-web`. Client `chat-desktop` đã gỡ khỏi IdP. Phần nói về desktop/Tauri bên dưới chỉ còn là lịch sử.

## Bối cảnh

Tin nhắn có định dạng (đậm, nghiêng, link, nhắc tên, code) được tạo ở client web, client native, bot và incoming webhook, rồi hiển thị trên mọi client. Lưu HTML hay Markdown thì mỗi bên phải parse lại và mở đường cho XSS. Link trong tin và trong nút của bot là bề mặt tấn công trực tiếp: một scheme như `javascript:`, `file:` hay `ms-msdt:` có thể chạy mã khi người dùng bấm. Giới hạn độ dài phải cho cùng một kết quả ở client và server, kể cả với emoji và tiếng Việt.

## Quyết định

- Tin nhắn lưu và truyền dưới dạng `text` thuần cộng mảng `entities[]`. Mỗi entity mô tả một đoạn có định dạng bằng `offset` và `length`.
- `offset` và `length` đếm theo code unit UTF-16.
- URL trong entity và trong nút (`reply_markup`) chỉ được dùng scheme `http`, `https`, `mailto` và scheme riêng của app (`{{scheme}}` lấy từ `brand.config.json`, xem [ADR 0008](./0008-branding-and-naming.md)). Mọi scheme khác bị từ chối.
- Server kiểm allowlist scheme khi ghi tin từ mọi nguồn (client, Bot API, webhook). Client kiểm lại trước khi mở link ra ngoài, trên cả web, Capacitor và Tauri.
- Giới hạn độ dài tin đếm theo code point. Giá trị giới hạn do server cấp qua `GetAppConfig`, client không hardcode.
- Helper entities và kiểm scheme có ở cả TypeScript (`packages/core`) và Go (`server/internal/entities`), cùng chạy trên một bộ test có emoji nhiều code unit và các scheme `javascript:`, `file:`, `ms-msdt:`.

## Lý do

- `text + entities` là mô hình Telegram dùng: không có markup để chèn, client render từ cấu trúc dữ liệu chứ không từ chuỗi HTML.
- Chuỗi JavaScript là UTF-16, nên offset UTF-16 cho phép client web cắt chuỗi trực tiếp mà không quy đổi. Server Go là bên phải quy đổi, và chỉ ở một chỗ.
- Allowlist an toàn hơn blocklist: scheme nguy hiểm mới xuất hiện theo hệ điều hành và ứng dụng cài thêm, không liệt kê hết được.
- Kiểm ở cả hai đầu vì client cũ hoặc nội dung từ bot có thể đi vòng qua một trong hai lớp.
- Đếm theo code point không phụ thuộc cách mã hoá nội bộ của từng ngôn ngữ; đếm theo UTF-16 sẽ tính một emoji thành hai ký tự.

## Hệ quả

- Server phải quy đổi offset UTF-16 khi cắt hay kiểm entity trong Go.
- Hai cách đếm cùng tồn tại: offset theo UTF-16, độ dài tối đa theo code point. Helper phải đặt tên rõ để không nhầm.
- Tin có link với scheme ngoài allowlist bị từ chối khi ghi, bất kể nguồn là người dùng, bot hay webhook.
- Fold tiếng Việt cho tìm kiếm áp lên `text`, theo [ADR 0005](./0005-vietnamese-fold.md).
- Đây là một trong hai nền chống XSS, CSRF và CSWSH; nền còn lại là cách lưu phiên ở [ADR 0006](./0006-sign-in-and-chat-sessions.md).

## Cách thay đổi

- Thêm scheme vào allowlist: sửa cả server lẫn client trong cùng đợt. Client cũ vẫn từ chối mở scheme mới, đây là hướng hỏng an toàn.
- Thêm loại entity: thêm giá trị enum trong protobuf; client cũ phải hiện đoạn đó như văn bản thường.
- Đổi đơn vị offset là thay đổi phá vỡ với mọi client và bot: cần trường mới song song và một phiên bản Bot API mới.
- Đổi giới hạn độ dài chỉ cần đổi cấu hình trả qua `GetAppConfig`.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
