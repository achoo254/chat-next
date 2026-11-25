# Giấy phép tài sản hình ảnh của web

Nguồn gốc và quyền với các ảnh vẽ bằng AI mà web phát hành. Mọi ảnh dưới đây được vẽ offline trên GPU cục bộ hoặc dựng bằng script; không có tài
sản tải từ thư viện bên ngoài. Prompt, ảnh gốc, ảnh trung gian và script nằm ngoài repo này. Các model có giấy phép cấm thương mại (FLUX.1 dev,
FLUX.2 dev, Kontext dev, klein 9B, RMBG-2.0) không được dùng.

## Mascot Cố vấn (`apps/web/src/advisor/assets/`)

16 ảnh `<look>/<state>.webp` (`look` = owl, robot, suit, cat; `state` = idle, thinking, answering, sleeping), 256 px, nền trong suốt,
mỗi tệp dưới 19 KB. Vẽ offline trên GPU cục bộ ngày 16/11/2026: ảnh `idle` bằng Qwen-Image-2512, ba trạng thái còn lại bằng FLUX.2 klein 4B
(chỉnh sửa từ ảnh `idle`), tách nền bằng flood-fill từ bốn góc rồi xuất WebP. Cả hai model đều Apache-2.0. Không chứa chữ, không siêu dữ liệu.
Quyền với tệp: sở hữu của hoandat, giữ mọi quyền (không phải CC0). Prompt và ảnh gốc nằm ngoài repo này.

## Ảnh phiên trống (`apps/web/src/machines/assets/`)

`empty-session.webp`: mascot bong bóng thoại hiện trong phiên AI Agent chưa có nội dung, 384 px, nền trong suốt, 12 KB. Vẽ offline trên GPU
cục bộ ngày 18/11/2026 bằng Z-Image-Turbo (Apache-2.0), nền màu phẳng được tách thành trong suốt rồi xuất WebP. Không chứa chữ, không siêu
dữ liệu. Quyền với tệp: sở hữu của hoandat, giữ mọi quyền (không phải CC0). Prompt và ảnh gốc nằm ngoài repo này.

## Live Map

Không còn tài sản ảnh: từ 26/11/2026 cảnh vẽ bằng code ([ADR 0030](./adr/0030-observatory-machine-interior-v6.md)); tranh AI của ADR 0029 đã gỡ khỏi `apps/web/public/observatory/`.
