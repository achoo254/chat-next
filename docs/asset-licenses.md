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

Tài sản của tab Quan sát ([ADR 0027](./adr/0027-observatory-live-map.md)). Tên tệp có 8 ký tự mã băm nội dung, nên bảng dưới ghi theo mẫu tên.

| Loại | Tệp | Cách làm | Giấy phép công cụ / model | Quyền với tệp |
|---|---|---|---|---|
| Tấm nền | `observatory-plate-{2560,1280}.*.webp` | Cảnh Live Map không có phần diễn xuất (drone, phong thư, tài liệu bay, hộp, tia, lõi AI, nhân vật): FLUX.2 klein 4B chỉnh từ ảnh khái niệm đã duyệt của cảnh, dự phòng Qwen-Image-2512; phóng to bằng Real-ESRGAN x4plus rồi cắt hai cỡ WebP | FLUX.2 klein 4B (Apache-2.0), Qwen-Image-2512 (Apache-2.0), Real-ESRGAN x4plus (BSD-3-Clause) | Sở hữu của hoandat, giữ mọi quyền (không phải CC0) |
| Sprite | atlas `*.webp` và spritesheet `*.json` khi có | Z-Image-Turbo, tách nền bằng BiRefNet; sprite vẽ theo mẫu dùng FLUX.2 klein 4B, tách nền bằng khoá màu phẳng. Quầng sáng là hình tròn sinh bằng code | Z-Image-Turbo (Apache-2.0), BiRefNet (MIT), FLUX.2 klein 4B (Apache-2.0) | Sở hữu của hoandat, giữ mọi quyền |
| Bảng cảnh | `live-map-scene.*.json` | Toạ độ trạm, vùng bấm, neo nhãn đo trên tấm nền, ghi bằng tay và script | — | Như mã nguồn của repo |
| Bảng tài sản | `observatory-assets.json` | Sinh bằng script | — | Như mã nguồn của repo |

Tấm nền đang phát hành là bản tạm: ảnh khái niệm của cảnh (vẽ bằng AI cho hệ sinh thái ngày 21/11/2026) được cắt thẳng thành hai cỡ, chưa qua
bước vẽ lại ở trên; model của ảnh khái niệm không được ghi lại lúc vẽ. Chưa có atlas sprite nào (`atlases` rỗng), cảnh vẽ phần diễn xuất bằng hình
khối. Khi tấm nền và sprite vẽ xong thì thay tệp theo tên trong `observatory-assets.json` và ghi ngày vẽ vào bảng trên. WebP được ghi không kèm siêu
dữ liệu (không đường dẫn máy, không tên máy, không workflow ComfyUI nhúng). Không ảnh nào chứa chữ.

Ghi trong phần ghi công: "AI-generated for the hoandat ecosystem; owned by hoandat, all rights reserved (not CC0)".
