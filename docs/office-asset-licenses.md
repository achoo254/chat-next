# Giấy phép tài sản Văn phòng (`apps/web/public/office/`)

Mọi tệp trong `apps/web/public/office/` là tài sản của tab Văn phòng: toà nhà 3 tầng 3D (vỏ tầng có lightmap, đồ đạc dùng instancing),
ảnh 2D dựng sẵn, nhân vật có xương, phụ kiện, tiếng hiệu ứng và bảng tài sản `office-assets.json`. Tất cả được sinh bằng AI chạy cục bộ
hoặc dựng bằng công cụ, rồi render hay đóng gói; không có tài sản tải từ thư viện bên ngoài ngoài các clip chuyển động CC0 ghi dưới đây.
Tên tệp có 8 ký tự mã băm nội dung, nên bảng dưới ghi theo mẫu tên.

Kiểm giấy phép model ngày 15/11/2026 (thẻ model trên Hugging Face và README của từng dự án).

## Nguồn và giấy phép theo loại

| Loại | Tệp | Cách làm | Giấy phép công cụ / model | Quyền với tệp |
|---|---|---|---|---|
| Vỏ tầng | `office-floor-{1,2,3}.*.glb` | Dựng trong Blender theo `machines/office/office-layout.json` (sàn, tường, cửa sổ, rèm, vách kính, thang máy, cầu thang, thảm, khung tranh, bảng, đồng hồ) | Blender 5.3 (GPL, chỉ là công cụ; tệp xuất không chịu GPL) | Sở hữu của hoandat, giữ mọi quyền (không phải CC0) |
| Lightmap | `lightmap-floor-{1,2,3}-{day,night}-{1024,2048}.*.webp` | Bake Cycles từ cảnh trên, gồm texture sàn và tranh, bảng sinh bằng AI | Blender (GPL, công cụ); ảnh: Qwen-Image-2512 (Apache-2.0) | Sở hữu của hoandat, giữ mọi quyền |
| Đồ đạc | `office-props-floor-{1,2,3}.*.glb` | Đồ mềm và đồ gỗ (sofa, ghế bành, cây, kệ sách, bàn, tủ...): ảnh concept bằng Qwen-Image-2512, mesh và texture bằng TRELLIS.2, dọn và giảm mặt bằng Blender và meshoptimizer. Đồ cứng (ghế xoay, máy in, tủ rack, két, tủ đồ, tủ lạnh, thùng rác, bình nước, cổng soát vé, bàn thử...), giấy, giấy ghi chú: dựng bằng script trong Blender từ khối cơ bản | Qwen-Image-2512 (Apache-2.0), TRELLIS.2 4B (MIT; bộ mã hoá ảnh DINOv3 theo giấy phép DINOv3 của Meta, chỉ ràng buộc việc phân phối trọng số, không ràng buộc mô hình sinh ra), meshoptimizer (MIT) | Sở hữu của hoandat, giữ mọi quyền |
| Ảnh 2D | `office-2d-floor-{1,2,3}-{day,night}-{desktop,phone}.*.webp` | Render Cycles của chính cảnh 3D (vỏ tầng và đồ đạc ở trên) bằng camera mặc định | Blender (GPL, công cụ) | Sở hữu của hoandat, giữ mọi quyền |
| Nhân vật | `character.*.glb` | Dựng bằng script trong Blender từ khối cơ bản (đầu, tóc, áo, quần yếm, tay, giày); mặt vẽ bằng Qwen-Image-2512 rồi chiếu lên đầu; gắn xương bằng Mesh2Motion; clip gõ phím `Typing` dựng trong Blender | Qwen-Image-2512 (Apache-2.0), Mesh2Motion (mã MIT, chạy cục bộ, không phân phối) | Mesh và texture: sở hữu của hoandat, giữ mọi quyền |
| Clip chuyển động | trong `character.*.glb`: `Sitting_Idle`, `Sitting_Writing`, `Sitting_Talking`, `Idle_A`, `Interact`, `Walk`, `Idle_TalkingPhone`, `Consume`, `Victory`, `PickUp_Table` | Thư viện người của Mesh2Motion (khung xương người của Mesh2Motion) | **CC0** (Mesh2Motion, `LICENSE-CC0.MD`) | CC0 |
| Clip `Typing` | trong `character.*.glb` | Dựng trong Blender trên khung xương Mesh2Motion, từ thân ngồi của `Sitting_Writing` (CC0) | Blender (GPL, công cụ) | Sở hữu của hoandat, giữ mọi quyền |
| Biến thể nhân vật | `character-skins.*.webp` | Bake lại texture nhân vật với màu từng vùng khác nhau | (như nhân vật) | Sở hữu của hoandat, giữ mọi quyền |
| Phụ kiện | `accessories.*.glb` | Kính lúp, mũ bảo hộ, chồng sách, bảng kẹp giấy, đèn pin, tai nghe, cốc, kính cận: dựng bằng script trong Blender | Blender (GPL, công cụ) | Sở hữu của hoandat, giữ mọi quyền |
| Tiếng hiệu ứng | `sfx/*.*.mp3` | ACE-Step 1.5 trên ComfyUI cục bộ, cắt và cân mức bằng script | ACE-Step 1.5 (MIT theo thẻ model; vài tệp mã nguồn của dự án ghi Apache-2.0, cả hai đều cho dùng thương mại) | Sở hữu của hoandat, giữ mọi quyền |
| Bảng tài sản | `office-assets.json` | Sinh bằng script | — | Như mã nguồn của repo |

Cả hai model vẽ ảnh (Qwen-Image-2512, FLUX.2 klein 4B) đều Apache-2.0, cho dùng thương mại; các model có giấy phép cấm thương mại (FLUX.1
dev, FLUX.2 dev, Kontext dev, klein 9B, RMBG-2.0) không được dùng. Không ảnh hay texture nào chứa chữ.

## Siêu dữ liệu

GLB chỉ ghi `asset.generator = "hoandat office-art"`, `asset.extras` (mã băm bố cục, danh sách instance) và tên mesh; WebP và MP3 được ghi
không kèm siêu dữ liệu (không đường dẫn máy, không tên máy, không workflow ComfyUI nhúng). Prompt, ảnh trung gian, mesh thô và script nằm
ngoài repo này.

## Mascot Cố vấn (`apps/web/src/advisor/assets/`)

16 ảnh `<look>/<state>.webp` (`look` = owl, robot, suit, cat; `state` = idle, thinking, answering, sleeping), 256 px, nền trong suốt,
mỗi tệp dưới 19 KB. Vẽ offline trên GPU cục bộ ngày 16/11/2026: ảnh `idle` bằng Qwen-Image-2512, ba trạng thái còn lại bằng FLUX.2 klein 4B
(chỉnh sửa từ ảnh `idle`), tách nền bằng flood-fill từ bốn góc rồi xuất WebP. Cả hai model đều Apache-2.0. Không chứa chữ, không siêu dữ liệu.
Quyền với tệp: sở hữu của hoandat, giữ mọi quyền (không phải CC0). Prompt và ảnh gốc nằm ngoài repo này.

## Ảnh phiên trống (`apps/web/src/machines/assets/`)

`empty-session.webp`: mascot bong bóng thoại hiện trong phiên AI Agent chưa có nội dung, 384 px, nền trong suốt, 12 KB. Vẽ offline trên GPU
cục bộ ngày 18/11/2026 bằng Z-Image-Turbo (Apache-2.0), nền màu phẳng được tách thành trong suốt rồi xuất WebP. Không chứa chữ, không siêu
dữ liệu. Quyền với tệp: sở hữu của hoandat, giữ mọi quyền (không phải CC0). Prompt và ảnh gốc nằm ngoài repo này.
