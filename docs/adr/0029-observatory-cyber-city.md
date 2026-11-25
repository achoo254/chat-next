# ADR 0029: Live Map là một thành phố số, camera theo việc AI làm

Trạng thái: **đã chấp nhận** (25/11/2026, đại ca duyệt bản mẫu và hướng Cyber City). Thay phần hình ảnh và bố cục của
[ADR 0027](./0027-observatory-live-map.md); dữ liệu, tua lại, ngăn khoan sâu, điểm nghẽn, riêng tư và CSP của ADR 0027 giữ nguyên.

## Bối cảnh

Cảnh của ADR 0027 là một bức tranh phong cách game (quả cầu mặt cười, drone, cây phát sáng). Khi xem một phiên đang chạy, chủ sở hữu thấy tranh ít
giúp biết Claude Code đang làm gì: việc hiện tại chỉ là nhãn chữ nhỏ trên tranh, cảnh gần như đứng yên, và nét "hoạt hình" không hợp với công việc.
Một bản mẫu bố cục (bên trong máy, model là lưới nơ-ron, internet là cổng không gian) được duyệt về hành vi nhưng bị chê giống sơ đồ network
monitoring; hướng chọn cuối là một thành phố số isometric.

## Quyết định

- **Thành phố số isometric bên trong máy**: tháp AI ở giữa; các khu quanh tháp theo trạm (kho tệp, Git · CI/CD, kiểm thử, terminal, MCP, internet,
  bộ nhớ, kỹ năng, khoá quyền, cổng nhập, bể ngữ cảnh); đường năng lượng nối tháp với từng khu; subagent là drone bay tới khu nó đang làm.
- **Hình ảnh 100% vẽ bằng model AI chạy offline** trên GPU của PC (FLUX.2 klein 4B, Qwen-Image-2512, Real-ESRGAN): cả thành phố là một tấm nền liền,
  thêm một bản "bật đèn" cắt theo từng khu; renderer làm sáng khu đang làm bằng cách hiện dần lớp sáng của khu đó. Code chỉ vẽ lớp dữ liệu (đường
  năng lượng, gói dữ liệu, đường ống CI/CD, sóng token) và chữ vẫn là DOM. Giấy phép: [`asset-licenses.md`](../asset-licenses.md).
- **Thẻ hoạt động là chỗ đọc chính** trên cảnh: trạng thái (Đang chạy, Thành công, Lỗi, Suy nghĩ, Đang chờ, Rảnh), `Runtime` của lần chạy hiện tại,
  `p95 lịch sử` của các lần trước trong phiên và số lần gọi luôn có nhãn riêng; mô tả và output (khi xong) qua đường nội dung theo id, chỉ khi dự án
  bật nội dung và "Ẩn chi tiết" tắt; dòng hành trình; nút xem chi tiết. **Không báo phần trăm giả**: thanh tiến độ chạy kiểu không xác định khi không có
  số thật.
- **Suy nghĩ khác thực thi**: suy nghĩ thì tháp sáng, khu khác mờ; thực thi thì dòng năng lượng chạy từ tác nhân (tháp hoặc drone) tới khu đang làm.
- **Camera theo hành động, không theo sự kiện**: chỉ đổi góc khi việc chuyển sang khu khác và ổn định; giữ khu đang làm qua khoảng suy nghĩ ngắn
  tính từ lúc tool kết thúc. Ba chế độ Tự động, Tự do (kéo, cuộn), Tập trung (khoá vào khu đã chọn).
- **Rảnh có chuyển động nhẹ** ở nhịp tối đa 20 khung/giây; giảm chuyển động hoặc tiết kiệm dữ liệu thì 0 khung; trang ẩn, app nền, canvas khuất vẫn 0 khung.
- **CI/CD**: agent đánh dấu lệnh theo dõi CI (`gh run …`, `gh pr checks`, `glab ci …`) bằng cờ `ci` (bit 128) và sau mỗi `git push` vào repo GitHub tự
  hỏi GitHub Actions bằng `gh` đã đăng nhập của người dùng, ghi sự kiện `ci_started`/`ci_finished`
  ([`observatory-wire.md`](../observatory-wire.md)); tắt bằng `tunelo observatory ci off`. Máy không có `gh` thì bỏ qua.

## Hệ quả

- Tài sản Live Map khoảng 0,8 MB (tấm nền hai cỡ, ba atlas); vẽ lại theo `hoandat-app/tools/observatory-art/README.md`.
- Ngân sách khung hình rảnh của ADR 0027 ("rảnh 0 khung") đổi thành "rảnh ≤ 20 khung/giây, 0 khi giảm chuyển động"; e2e kiểm cả hai.
- Theo dõi CI thêm một phụ thuộc mềm vào `gh` của người dùng và tối đa khoảng 120 lệnh `gh run list` cho mỗi lần push (15 giây một lần, tối đa 30 phút).
