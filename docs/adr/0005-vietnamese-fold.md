# ADR 0005: Fold tiếng Việt cho tìm kiếm

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14

## Bối cảnh

Người dùng Việt thường gõ không dấu và vẫn muốn tìm ra tin có dấu: "nguoi dep da nang" phải khớp "Người đẹp Đà Nẵng". Tìm kiếm chạy ở hai nơi: server (Meilisearch) và client (SQLite FTS5 trong DB local). Nếu hai nơi bỏ dấu khác nhau, cùng một truy vấn cho hai kết quả khác nhau. SQLite FTS5 với `remove_diacritics 2` không đổi `đ`/`Đ` thành `d` (đã kiểm chứng bằng `sqlite3`), vì `đ` là một chữ cái riêng chứ không phải `d` cộng dấu. Vì vậy fold phải là hàm của ứng dụng, có đặc tả và test vector dùng chung.

## Quyết định

Hàm fold biến một chuỗi thành chuỗi đã bỏ dấu, theo đúng thứ tự sau:

1. Chuẩn hoá NFC.
2. Chuyển thành chữ thường.
3. Chuẩn hoá NFD.
4. Bỏ mọi ký tự có General Category `Mn`. Nhóm này gồm dấu thanh, dấu mũ, dấu móc của ơ/ư và dấu trăng của ă.
5. Đổi `đ` thành `d`.
6. Chuẩn hoá NFC.
7. Gộp chuỗi khoảng trắng liên tiếp thành một.
8. Tách token theo Unicode word boundary.

- Đặc tả chuẩn và bộ test vector nằm ở [`spec/vi-fold/SPEC.md`](../../spec/vi-fold/SPEC.md) và `spec/vi-fold/test-vectors.json`. Bộ vector có ít nhất 300 mục, phủ ă, â, ê, ô, ơ, ư, đ, chữ hoa và thường, đầu vào đã ở dạng NFD, emoji và chữ tiếng Anh lẫn vào.
- Có hai bản hiện thực: TypeScript ở `packages/core` (dùng cho FTS5 local) và Go ở `server/internal/vifold` (dùng cho chỉ mục server). CI chạy cùng một file vector cho cả hai và đòi kết quả giống hệt.
- Cả nội dung được index lẫn truy vấn đều dùng `searchText` (TS) / `SearchText` (Go): các token nối bằng một khoảng trắng. Search engine tự tách lại chuỗi được đưa vào, và FTS5 `unicode61` mặc định tách `1.250.000` ở dấu chấm nhưng giữ `日本語` thành một token (đã kiểm chứng bằng `sqlite3`), nên đưa `fold` cho engine thì token của engine không còn khớp `tokens`.
- FTS5 local dùng đúng cấu hình tokenizer ghi ở mục 4.1 của SPEC (hằng `FTS5_TOKENIZE`): chỉ khoảng trắng tách token. Test `node:sqlite` đòi token FTS5 của `searchText` bằng `tokens` trên mọi vector.
- Meilisearch trên server phải được cấu hình (`separatorTokens`, `nonSeparatorTokens`) để token của nó khớp `tokens`; phase tìm kiếm kiểm chứng việc này bằng cùng bộ vector. Sai khác còn lại chỉ được chấp nhận kèm danh sách đã đo, ghi vào SPEC.
- DB local lưu phiên bản fold: phiên bản đặc tả cộng phiên bản Unicode/ICU của runtime (`process.versions.unicode`/`icu` trên Node và Electron, phiên bản engine trong user agent trên web và WebView vì `Intl` không trả về phiên bản ICU; native xác định sau). Khi chuỗi này đổi, DB tính lại `searchText` và dựng lại chỉ mục FTS5, vì ICU của WebView được cập nhật theo hệ điều hành chứ không theo app.
- Thứ hạng: Meilisearch tự bỏ dấu ở mọi trường nên không tự xếp kết quả khớp đúng dấu lên trước. Server lấy top-K từ engine rồi xếp lại ở tầng Go bằng điểm khớp trên chuỗi gốc có dấu.

## Lý do

- Bước chữ thường đứng trước NFD để `Đ` thành `đ` rồi bước 5 chỉ cần xử lý một ký tự.
- Bỏ theo cả nhóm `Mn` thay vì liệt kê từng dấu tiếng Việt: dấu móc và dấu trăng cũng thuộc `Mn`, và quy tắc không phụ thuộc vào việc liệt kê đủ.
- NFC ở đầu và cuối làm cho đầu vào NFD (thường gặp khi dán từ macOS) cho kết quả giống đầu vào NFC.
- Một đặc tả cộng một bộ vector dùng chung là cách rẻ nhất để giữ TS và Go khớp nhau lâu dài; CI bắt lệch ngay khi một bên đổi.
- Telegram Desktop chỉ tìm ở server vì không lưu tin local; app này có SQLite local nên cần fold ở cả client.

## Hệ quả

- Bảng FTS5 local index cột `searchText`, với `remove_diacritics 0` và cấu hình tokenizer của SPEC, không dựa vào tuỳ chọn bỏ dấu hay cách tách từ mặc định của FTS5. Truy vấn đưa từng token của `searchText(query)` vào `MATCH` dưới dạng chuỗi FTS5 có trích dẫn.
- Cập nhật hệ điều hành có thể làm DB local dựng lại chỉ mục FTS5 một lần khi mở app.
- `spec/vi-fold/generate-vectors.mjs` dùng chung logic với bản TS (cùng `Intl.Segmenter`, cùng tailoring), nên phép kiểm độc lập là bản Go và test FTS5, không phải script tạo vector.
- Gõ có dấu vẫn tìm ra tin không dấu và ngược lại; khớp đúng dấu chỉ ảnh hưởng thứ hạng phía server.
- Mọi thay đổi ở một bản hiện thực mà không đổi vector sẽ làm CI đỏ.

## Cách thay đổi

- Đổi đặc tả: sửa `SPEC.md` và vector trước, rồi sửa đồng thời bản TS và Go trong cùng thay đổi.
- Server: dựng lại toàn bộ chỉ mục Meilisearch với hàm fold mới. Server fold cả tài liệu lẫn truy vấn nên không phụ thuộc phiên bản client.
- Client: phiên bản đặc tả mới làm đổi phiên bản fold lưu trong DB local, nên DB tự tính lại `searchText` và dựng lại bảng FTS5 khi mở. Client cũ vẫn nhất quán với chính DB của nó cho tới khi cập nhật.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
