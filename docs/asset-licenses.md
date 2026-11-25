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

## Live Map (`apps/web/public/observatory/`)

Tài sản của tab Quan sát ([ADR 0027](./adr/0027-observatory-live-map.md), hình ảnh theo [ADR 0029](./adr/0029-observatory-cyber-city.md)).
Tên tệp có 8 ký tự mã băm nội dung, nên bảng dưới ghi theo mẫu tên. Tất cả vẽ ngày 25/11/2026 bằng model AI chạy offline trên GPU của PC ở nhà
(ComfyUI); prompt, seed và cách làm ở `hoandat-app/tools/observatory-art/` (riêng tư).

| Loại | Tệp | Cách làm | Giấy phép công cụ / model | Quyền với tệp |
|---|---|---|---|---|
| Tấm nền | `observatory-plate-{2400,1200}.*.webp` | Thành phố số isometric: FLUX.2 klein 4B vẽ lại từ ảnh mẫu của chủ sở hữu (bỏ chữ và giao diện), thêm một lượt làm sạch và một lượt đặt các khu nhỏ lên bệ; phóng to bằng Real-ESRGAN x2plus rồi cắt hai cỡ WebP | FLUX.2 klein 4B (Apache-2.0), Real-ESRGAN x2plus (BSD-3-Clause) | Sở hữu của hoandat, giữ mọi quyền (không phải CC0) |
| Lớp sáng các khu | atlas `observatory-lit.*` | Cùng thành phố "bật đèn" (FLUX.2 klein 4B theo tấm nền), cắt theo từng khu, viền mờ dần bằng script | FLUX.2 klein 4B (Apache-2.0) | Sở hữu của hoandat, giữ mọi quyền |
| Sprite | atlas `observatory-core.*` | Vành sáng, cột ngữ cảnh, cổng xoáy, gói dữ liệu, quầng sáng: Qwen-Image-2512 trên nền đen, tách theo độ sáng; drone và bảng holographic: FLUX.2 klein 4B theo tháp AI, tách nền bằng khoá màu phẳng | Qwen-Image-2512 (Apache-2.0), FLUX.2 klein 4B (Apache-2.0) | Sở hữu của hoandat, giữ mọi quyền |
| Bảng cảnh | `live-map-scene.*.json` | Vị trí các khu, đường năng lượng, neo nhãn đo trên tấm nền | — | Như mã nguồn của repo |
| Bảng tài sản | `observatory-assets.json` | Sinh bằng script | — | Như mã nguồn của repo |

WebP được ghi không kèm siêu dữ liệu (không đường dẫn máy, không tên máy, không workflow ComfyUI nhúng). Không ảnh nào chứa chữ.

Ghi trong phần ghi công: "AI-generated for the hoandat ecosystem; owned by hoandat, all rights reserved (not CC0)".
