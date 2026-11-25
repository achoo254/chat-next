# ADR 0030: Live Map là bên trong máy theo bản mẫu v6, vẽ bằng Canvas 2D

Trạng thái: **đã chấp nhận** (26/11/2026, đại ca quyết định sau khi xem thành phố số trên phiên thật). Thay phần hình ảnh và bố cục của
[ADR 0029](./0029-observatory-cyber-city.md); bỏ ngăn khoan sâu và thanh tua lại của [ADR 0027](./0027-observatory-live-map.md) khỏi Live Map.
Dữ liệu, riêng tư, CSP, điểm nghẽn ở agent, camera theo hành động và theo dõi CI của hai ADR đó giữ nguyên.

## Bối cảnh

Thành phố số isometric của ADR 0029 (tranh AI, lớp sáng theo khu, bảng holographic) rối mắt khi xem phiên thật: khó thấy việc đang chạy giữa
nhiều chi tiết trang trí. Ngăn khoan sâu (so với 5 phiên trước, mục chậm nhất) và thanh tua lại dưới bản đồ cũng không được dùng khi theo dõi.
Bản mẫu v6 (`hoandat-app/plans/dattqh/261125-2211-observatory-machine-interior/reports/prototype-v6.html`) đã được duyệt về hành vi trước đó.

## Quyết định

- **Giao diện y hệt bản mẫu v6**: thẻ hoạt động trên cùng; cảnh bên trong máy 1200 × 720 (model là lưới nơ-ron ở giữa, bể ngữ cảnh và sóng token
  bên trái, kho tệp, terminal, kiểm thử, Git · CI/CD bên dưới, cổng MCP và cổng không gian internet bên phải, bộ nhớ, kỹ năng, khoá quyền, cổng nhập nhỏ
  ở rìa; đường dẫn từ model tới từng khối, dày theo số lần gọi, phần đỏ theo tỷ lệ lỗi, nhãn tách runtime khỏi p95 lịch sử) với ba chế độ camera và bản
  đồ tổng quan; cột phải gồm **Phiên** (model, ngữ cảnh, tốc độ, lần gọi tool, subagent, "Ẩn chi tiết"), **Chi tiết** (sự kiện hoặc khối được chọn) và
  **Sự kiện** (mới nhất trên cùng, tối đa 80 dòng: giờ, màu khối, nội dung, runtime ✓ / lỗi / chạy…); dưới cùng là chú giải cách đọc cảnh. Một giao
  diện tối cố định, theo màu của bản mẫu.
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
