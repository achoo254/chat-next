# ADR 0030: Live Map là bên trong máy theo bản mẫu v6, vẽ bằng Canvas 2D

Trạng thái: **đã chấp nhận** (26/11/2026, đại ca quyết định sau khi xem thành phố số trên phiên thật). Thay phần hình ảnh và bố cục của
[ADR 0029](./0029-observatory-cyber-city.md); bỏ ngăn khoan sâu và thanh tua lại của [ADR 0027](./0027-observatory-live-map.md) khỏi Live Map.
Dữ liệu, riêng tư, CSP, điểm nghẽn ở agent, camera theo hành động và theo dõi CI của hai ADR đó giữ nguyên.

## Bối cảnh

Thành phố số isometric của ADR 0029 (tranh AI, lớp sáng theo khu, bảng holographic) rối mắt khi xem phiên thật: khó thấy việc đang chạy giữa
nhiều chi tiết trang trí. Ngăn khoan sâu (so với 5 phiên trước, mục chậm nhất) và thanh tua lại dưới bản đồ cũng không được dùng khi theo dõi.
Bản mẫu v6 (`hoandat-app/plans/dattqh/261125-2211-observatory-machine-interior/reports/prototype-v6.html`) đã được duyệt về hành vi trước đó.

## Quyết định

- **Giao diện y hệt bản mẫu v6**: thẻ hoạt động trên cùng; cảnh bên trong máy (model là lưới nơ-ron ở giữa, khối Context và sóng token
  bên trái, kho tệp, terminal, kiểm thử, Git · CI/CD bên dưới, cổng MCP và cổng internet bên phải, bộ nhớ, kỹ năng, khoá quyền, cổng nhập nhỏ
  ở rìa; đường dẫn từ model tới từng khối, dày theo số lần gọi, phần đỏ theo tỷ lệ lỗi, nhãn tách runtime khỏi p95 lịch sử) với ba chế độ camera (bản đồ tổng quan của v6
  bỏ theo yêu cầu 26/11/2026; nút camera nằm dưới cảnh để không che khối nào); cột phải gồm **Phiên** (model, ngữ cảnh, tốc độ, lần gọi tool, subagent, "Ẩn chi tiết"), **Chi tiết** (sự kiện hoặc khối được chọn) và
  **Sự kiện** (mới nhất trên cùng, tối đa 80 dòng: giờ, màu khối, nội dung, runtime ✓ / lỗi / chạy…); dưới cùng là chú giải cách đọc cảnh. Một giao
  diện tối cố định, theo màu của bản mẫu. Thẻ hoạt động giữ chiều cao cố định (mọi dòng luôn có chỗ, kể cả khi trống) để không nháy dòng;
  dòng Hành trình xuống dòng thay vì cắt "…", luôn thấy các bước mới nhất; tool MCP ghi `máy chủ › tool`. Bố cục của v6 được nới ra
  (cảnh 1500 × 900 thay 1200 × 720, chữ lớn hơn 15 %): đường dẫn dài hơn và mỗi đường ghi số liệu ở một chỗ trống định sẵn, test kiểm nhãn không
  chạm khối nào, không chạm tên model và không chạm nhau.
- **Chỉnh giao diện 26/11/2026** (theo bản mẫu mới): hàng trên là thẻ hoạt động ba cột (việc đang làm với thanh chạy không xác định; Runtime, p95 lịch sử,
  Lần gọi mỗi số một nhãn; nút "Xem chi tiết" ở góc phải trên cùng cạnh Hành trình) cạnh hộp **Phiên** (đưa lên hàng trên, có biểu tượng, thanh nhỏ cho ngữ cảnh);
  Hành trình là các khối biểu tượng tối đa hai dòng, bước mới nhất sáng ở cuối, bước cũ rơi ra sau "…"; thẻ không còn dòng tok/s và ngữ cảnh (đã có ở Phiên và trên cảnh).
  Mỗi khối vẽ đúng thứ nó là: kho tệp là ma trận ô (tệp đọc sáng xanh, tệp sửa sáng vàng, tìm quét một cột), terminal là cửa sổ shell với các lệnh gần nhất và kết quả,
  kiểm thử là dải ô đổi màu theo **kết quả của lượt chạy** (Claude Code không báo từng test, nên không có số đạt/lỗi từng ca), Git là đồ thị commit
  (main, HEAD, nhánh phụ từ 5 commit) cạnh đường ống phát hành, cổng MCP là các cổng kết nối có biểu tượng dịch vụ; khối nhỏ có biểu tượng riêng. Ở chế độ camera **Tự do**,
  mọi khối và đường dẫn sáng bình thường (không làm mờ khối ngoài vùng AI đang làm); Tự động và Tập trung vẫn làm mờ.
- **Vẽ bằng Canvas 2D trong code**, không PixiJS, không tài sản ảnh: bỏ `pixi.js`, `public/observatory/`, bộ đệm tranh của service worker (cache
  `observatory-assets-v1` bị xoá khi worker kích hoạt) và location `/observatory/` của nginx. Chữ trên cảnh vẽ trên canvas như bản mẫu; mỗi khối vẫn
  là một nút DOM trong suốt để dùng bàn phím và để test bấm.
- **Chi tiết tính từ sự kiện của chính phiên** (p50/p95 lịch sử, lỗi, các lần gọi gần đây, bước của đường ống Git); máy chỉ được hỏi nội dung theo id
  (mô tả và output của một lần gọi), như trước.
- **Không tua lại, không ngăn khoan sâu** trên Live Map. Link `?event=` mở thẳng chi tiết của sự kiện đó; `?at=` không còn tác dụng.

## Hệ quả

- Chunk Live Map nhỏ hơn hẳn (không còn PixiJS và 0,8 MB tranh); CSP không cần ngoại lệ nào cho cảnh.
- Giữ nguyên ngân sách khung hình của ADR 0029: rảnh ≤ 20 khung/giây, 0 khi giảm chuyển động hoặc tiết kiệm dữ liệu.
- Yêu cầu `observatoryStation` và trang các sự kiện cũ (`observatoryEarlier`) của giao thức vẫn còn ở agent, web không gọi nữa.
- Tranh và công cụ vẽ ở `hoandat-app/tools/observatory-art/` không còn được app dùng.
