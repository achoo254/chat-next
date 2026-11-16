# ADR 0018: Văn phòng của phiên AI: toà nhà 3D Babylon.js, luồng hoạt động do agent chuẩn hoá

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-15
- Bổ sung [ADR 0013](./0013-remote-machines.md), [ADR 0014](./0014-tunelo-machine-agent.md) và [ADR 0017](./0017-provider-neutral-ai-agent.md).

## Bối cảnh

Chủ sở hữu muốn mỗi phiên AI trong khu AI Agent có thêm tab thứ ba "Văn phòng" cạnh "Trò chuyện" và "Terminal": phiên là một công ty trong một
toà nhà nhỏ, agent chính là Giám đốc, mỗi subagent là một nhân viên, mỗi tool là một việc diễn ra ở đúng phòng của nó, người dùng là Chủ tịch.
Mục tiêu theo thứ tự: giải trí, thấy được AI đang làm gì, có cớ mở app. Tab chỉ để xem: không ô nhập, không điều khiển nhân viên, không thay chat.

Ràng buộc: chạy được trên điện thoại (web và app Capacitor), nội dung phiên (lệnh, tệp, todo, tin nhắn) không được rời máy, hai AI (Claude và
Antigravity) phải dùng chung một giao diện, và relay hay máy chủ chat không đọc được gì (mọi khung đi qua kênh E2E sẵn có).

## Quyết định

### Engine: Babylon.js, WebGPU trước, WebGL2 sau

- Dùng Babylon.js (phiên bản ghim chính xác trong `apps/web/package.json`), thử WebGPU trước rồi rơi về WebGL2
  (`apps/web/src/office-3d/engine/create-render-engine.ts`), giống lựa chọn của Chùa Nhỏ (`chuanho-next`).
- Tái dùng bằng cách **chép mẫu** của Chùa Nhỏ (tạo engine, camera diorama, bảng ánh sáng, hậu kỳ, thư viện đồ đạc dùng instancing, vòng đời
  `use-babylon-world`), chưa làm gói chung. Tách sang `shared-next` khi có app 3D thứ ba; hai app thì chép rẻ hơn giữ hợp đồng gói.
- Chỉ import module cần của `@babylonjs/core`; toàn bộ phần 3D nạp lười khi mở tab, nằm ngoài bundle khởi động. Ngân sách chunk 3D do
  `apps/web/test/perf/budgets.ts` giữ (`pnpm perf`).
- Không có WebGL2 phần cứng (trình vẽ phần mềm bị loại), khởi động lỗi hay mất GPU context thì dùng bản 2D
  (`apps/web/src/office-3d/office-flags.ts`, `apps/web/src/office-3d/office-canvas.tsx`, `apps/web/src/machines/office/office-2d.tsx`).
- Tài sản chỉ dùng texture WebP và nén meshopt, không KTX2. Bộ giải meshopt là bản chạy trên luồng chính, tự phục vụ ở
  `apps/web/public/decoders/babylon/` (`apps/web/src/office-3d/engine/self-hosted-decoders.ts`): bản mặc định của Babylon tạo worker từ `blob:`,
  bị `worker-src 'self'` của CSP chặn. Nhờ vậy CSP không phải đổi; chỉ xét `worker-src blob:` nếu sau này phải bật KTX2.

### Cách vẽ: 3D toàn phần thời gian thực

- Mỗi tầng là một diorama: vỏ phòng (sàn, tường, thang máy, cầu thang) lắp trong Blender theo tệp bố cục, đồ đạc và đồ lặt vặt là GLB sinh bằng
  AI, nhân vật là một mesh gắn xương với nhiều texture. Script sinh và nguồn gốc nằm ở repo workspace riêng tư; repo này chỉ chứa tài sản đã xuất
  (`apps/web/public/office/`) và giấy phép ([`office-asset-licenses.md`](../office-asset-licenses.md)).
- Ánh sáng tĩnh bake thành hai lightmap cho mỗi tầng (ngày; đêm có đèn bàn và màn hình), trộn theo giờ máy xem
  (`apps/web/src/machines/office/office-daypart.ts`, `apps/web/src/office-3d/scene/lightmap-blend.ts`). Trạng thái phiên quyết định người; giờ máy
  xem chỉ quyết định ánh sáng.
- Hậu kỳ và bóng theo bậc chất lượng, bộ chỉnh tự động lên xuống bậc theo khung hình (`apps/web/src/office-3d/engine/quality-levels.ts`,
  `quality-scaler.ts`); đồ lặt vặt vẽ bằng instancing để không tốn draw call.
- Chỉ tầng đang xem được bật; tầng khác tắt hẳn (`apps/web/src/office-3d/scene/floor-library.ts`), người ở tầng khác vẫn đi theo thời gian trong
  logic. Vòng render dừng khi trang ẩn, canvas khuất, app Capacitor về nền hoặc mất GPU context (`apps/web/src/office-3d/render-gate.ts`); rời tab
  là huỷ toàn bộ tài nguyên engine (`apps/web/src/office-3d/use-office-world.ts`).
- Bác **2.5D** (ảnh nền vẽ bằng AI cộng nhân vật 3D trên camera hiệu chỉnh), đã thử trong ngày chốt: gần ảnh concept hơn, nhưng không xoay được
  camera và bố cục bị khoá vào một bức ảnh vẽ, đổi một phòng là vẽ lại cả tầng. 3D toàn phần đuổi theo nhìn của concept bằng lightmap, hậu kỳ và
  đồ lặt vặt, đổi lại phải sản xuất nhiều tài sản hơn.

### Toà nhà: 3 tầng, 12 phòng, mỗi phòng một tín hiệu thật

- Không có phòng trang trí: mỗi phòng (`OfficeRoom` trong `proto/remote/v1/remote.proto`) gắn với một tín hiệu có thật trong agent, kể cả Pantry
  (lúc phiên rảnh). Chọn dạng toà nhà nhiều tầng thay vì "mở phòng khi cần", để mỗi việc có chỗ cố định mà người xem học được.
- **Phân phòng trên máy**: agent chọn nhóm hoạt ảnh và phòng cho mỗi hoạt động (`apps/agent/src/office/office-activity-map.ts`,
  `office-command-room.ts`); lệnh shell chỉ được đọc trên máy để chọn phòng, nội dung lệnh không đi vào khung nào. Bảng phân phòng và cam kết dữ
  liệu: [`office-wire.md`](../office-wire.md) mục 4 và 8.
- **Xếp chỗ ở web**: bàn nhà, phòng gốc theo loại agent, thời gian ở lại một phòng, người dư bàn, Chủ tịch ở sảnh là việc trình bày nên nằm ở web,
  trong một hàm thuần dùng chung cho bản 3D và 2D (`apps/web/src/machines/office/office-placement.ts`). Đổi cách bày không cần phát hành agent.
- Thanh tầng tự theo tầng vừa có việc, có chặn để không nhảy tầng liên tục và ngừng một lúc khi người dùng tự chọn tầng
  (`apps/web/src/machines/office/office-floor-tabs.tsx`); không tự theo thì người xem chỉ thấy tầng 1 trong khi phần lớn việc diễn ra ở tầng khác.

### Tệp bố cục là nguồn sự thật

- Một tệp `apps/web/src/machines/office/office-layout.json` mô tả tầng, phòng, điểm neo, đồ thị lối đi và camera; cảnh 3D, bước lắp và bake trong
  Blender, và bản 2D (ảnh dựng sẵn từ chính cảnh 3D cộng nhãn HTML tại điểm neo) cùng đọc nó. Bộ kiểm ở `office-layout.ts`.
- Tệp tài sản `apps/web/public/office/office-assets.json` ghi `layoutSha256` của bố cục đã bake; web băm tệp bố cục đang chạy và bỏ tài sản lệch
  (`apps/web/src/machines/office/office-assets.ts`, `apps/web/src/office-3d/scene/scene-assets.ts`): sửa bố cục mà chưa bake lại thì cảnh dùng
  khối giữ chỗ đặt đúng bố cục mới, không bao giờ đặt đồ bake cũ sai chỗ.

### Agent chuẩn hoá, web không đọc transcript

- Mỗi adapter AI phát hoạt động đã chuẩn hoá (tool, nhóm hoạt ảnh, phòng, chủ đề rút gọn) qua message proto mới; web chỉ hiểu luồng đó
  (`apps/agent/src/office/`, `apps/agent/src/providers/claude/office-subagents.ts` cho bản ghi subagent của Claude). Lý do: dữ liệu thô (input,
  output, đường dẫn, biến môi trường) không bao giờ rời máy; Claude và Antigravity dùng chung giao diện; web không phụ thuộc định dạng transcript
  không có tài liệu; AI mới chỉ cần một adapter phía agent ([ADR 0017](./0017-provider-neutral-ai-agent.md)).
- AI không báo subagent (Antigravity) thì văn phòng chỉ có Giám đốc kèm dòng báo, không bao giờ bịa nhân viên (`OfficeState.reports_staff`).
- Có từ tunelo 3.6.0, không đổi số giao thức; web chỉ hiện tab khi máy đủ bản (`AGENT_OFFICE` trong `apps/web/src/machines/agent-version.ts`).

### Ảnh chụp và sự kiện có `seq`

- Thiết bị đăng ký bằng `OfficeWatch` (theo kiểu `WsWatch`), nhận một ảnh chụp rồi các sự kiện có `seq` tăng đúng 1; hở `seq`, epoch đổi hay nối
  lại thì đăng ký lại để lấy ảnh chụp mới, không có khung xin ảnh chụp riêng. `epoch` dùng lại epoch của core agent.
- Ảnh chụp cộng sự kiện cho ra đúng một trạng thái, không phụ thuộc giờ máy xem: `OfficeStore` thuần TypeScript, có unit test
  (`apps/web/src/machines/office/office-store.ts`), và luồng này phát lại được nếu sau này làm timelapse.

### Dùng lại liên kết làm nhịp tim

- Không thêm khung nhịp tim. Liên kết web đã ping định kỳ và coi im lặng lâu là chết (`apps/web/src/machines/link/machine-link.ts`); `OfficeStore`
  lấy trạng thái liên kết làm tín hiệu: không nghe tin từ máy quá 30 giây thì "mất điện", nối lại thì xin ảnh chụp mới rồi mới sáng đèn.
- Máy chủ Go không đổi logic: khung văn phòng được niêm phong E2E như mọi `Frame`, chỉ mã sinh từ proto đổi.

## Hệ quả

- Thêm một AI mới là thêm phần chuẩn hoá trong adapter của nó; web và proto không đổi. AI nào thiếu tín hiệu (subagent, chi phí, từ chối) thì
  văn phòng thiếu đúng phần đó, có ghi chú trên màn hình, không đoán thêm. Bảng tín hiệu theo loại phiên: [`office-wire.md`](../office-wire.md) mục 7.
- Đổi bố cục là đổi tệp bố cục, bake lại tài sản và dựng lại ảnh 2D; trong lúc chờ, cảnh dùng khối giữ chỗ.
- Hai bản sao mã 3D (chat-next và Chùa Nhỏ) tiến hoá độc lập cho tới khi có app 3D thứ ba.
- Tài sản 3D tải riêng khi mở tab, tầng nạp lười; điện thoại chạy cùng 3 tầng, dùng 6 trong 8 bàn của tầng 1.
- Ngoài phạm vi: điều khiển nhân viên, timelapse, lưu tiến độ kiểu game, chia sẻ clip, góc nhìn gộp mọi phiên.
