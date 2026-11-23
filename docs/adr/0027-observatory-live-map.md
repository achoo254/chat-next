# ADR 0027: Quan sát phiên Claude Code bằng Live Map 2D thay văn phòng 3D

Trạng thái: **đã chấp nhận** (23/11/2026, đại ca duyệt). Thay [ADR 0018](./0018-office-view-babylon-normalized-agent-stream.md),
[ADR 0019](./0019-office-living-floor-and-resident-talks.md) và [ADR 0021](./0021-office-single-plan-and-asset-cache.md). Dữ liệu đọc từ dòng thời
gian Observatory mà `tunelo` lưu trên máy; khung và cam kết dữ liệu: [`observatory-wire.md`](../observatory-wire.md).

## Bối cảnh

Tab "Văn phòng" vẽ phiên AI thành một toà nhà 3D Babylon.js: nhân vật, phòng, lịch sống, trò chuyện viết sẵn. Phần lớn những gì người xem thấy là
diễn xuất (người đi giữa khu, sinh hoạt theo giờ, bong bóng tán gẫu), không phải việc AI đang làm; tài sản 3D khoảng 24 MB, và văn phòng chỉ nhận
luồng hoạt động chuẩn hoá riêng của nó, không biết lượt API, token, chi phí, quyền, nén ngữ cảnh hay commit.

Observatory của agent nay lưu dòng thời gian của mọi phiên Claude Code trên máy trong SQLite (hook, OTel, spool của hook), kể cả phiên terminal và CLI
mở ngoài tunelo. Chủ sở hữu muốn thấy đúng việc thật: mỗi chuyển động có một sự kiện, bấm vào thì thấy sự kiện đó, có số khoan sâu, tua lại được và
thấy điểm nghẽn. Ràng buộc giữ nguyên: nội dung phiên không rời máy khi dự án tắt nội dung; relay và máy chủ chat không đọc được gì (kênh E2E sẵn có);
chạy được trên điện thoại (web, PWA, app Capacitor); CSP prod không có `'unsafe-eval'` và `worker-src` không có `blob:`.

## Quyết định

### Cảnh

- **Tab thứ ba "Quan sát" thay "Văn phòng".** Đường dẫn `…/office` cũ và chế độ "office" đã nhớ trên thiết bị mở Quan sát. Web bật tab khi máy đủ bản
  (`AGENT_LIVE_MAP` trong `apps/web/src/machines/agent-version.ts`). Phiên CLI mở từ danh sách "Phiên Claude Code trên máy" ở trang máy.
- **Live Map 2D bằng PixiJS v8** (phiên bản ghim chính xác trong `apps/web/package.json`): một tấm nền 2560×1920 (bản 1280×960 khi khung hẹp, GPU
  không nhận ảnh 2560 hoặc người dùng tiết kiệm dữ liệu) với mười trạm (Lõi AI, Điều phối agent, Hệ thống tệp, Kho bộ nhớ, Thư viện kỹ năng, Trạm MCP, API bên ngoài, Sandbox,
  Phòng kiểm thử, Git và CI/CD), bàn của người dùng, cổng bảo mật và màn giám sát. Bảng trạm ở một chỗ
  (`apps/web/src/machines/observatory/station-catalog.ts`), nên đổi tên trạm theo vai trò sau này chỉ đổi bảng và copy.
- **Không diễn xuất**: mọi chuyển động do một sự kiện thật gây ra và mang id của nó; bấm chuyển động mở chi tiết sự kiện, bấm trạm mở ngăn khoan sâu.
  Không cư dân, không lịch sống, không trò chuyện, không âm thanh, không hiệu ứng nền lúc rảnh.
- **Chữ là DOM**: nhãn trạm, ngăn khoan sâu, chi tiết sự kiện và thanh tua lại là HTML dùng token của web; canvas chỉ vẽ hình.
- **Vẽ theo yêu cầu, rảnh là đứng yên**: khung hình chỉ chạy khi có thứ đang chuyển động (`render/frame-gate.ts`), rảnh 0 khung hình. Dừng khi trang ẩn,
  app Capacitor về nền (`appStateChange`, vì trên Android trạng thái hiển thị của WebView không theo app), canvas khuất hoặc mất GPU context. Rời tab là
  huỷ toàn bộ renderer và tài nguyên GPU, không giữ gắn khi ẩn.
- **Renderer**: WebGL trước, Canvas của PixiJS sau, không WebGPU; không filter (Canvas không có), quầng sáng là sprite tròn tô `tint`. Không khởi tạo được
  hoặc mất context thì hiện tấm nền tĩnh, vẫn bấm được từng trạm.
- **CSP**: `import "pixi.js/unsafe-eval"` trước mọi thứ khởi tạo PixiJS (PixiJS v8 sinh mã đồng bộ uniform bằng `new Function`), và không dùng bộ nạp
  `Assets` của PixiJS (worker của nó tạo từ `blob:`); tấm nền và atlas nạp như ảnh thường. **Cấm nới CSP** để renderer chạy: không `'unsafe-eval'`,
  không `blob:`, không nguồn mới. `observatory-csp.e2e.ts` chạy cảnh dưới header CSP lấy từ conf nginx của prod.
- **Nhãn bàn người dùng** là email tài khoản chat đang đăng nhập, web tự lấy; không đi qua khung. "Ẩn chi tiết" (nhớ trên thiết bị) giấu tên tệp, tên
  miền, lệnh, tên tool MCP và email trên cảnh, ngăn và chi tiết.
- **Một bảng màu trạm** (`--c-station-*`, `apps/web/src/machines/observatory/station-palette.css`, chủ sở hữu duyệt 23/11/2026): mười màu phân biệt
  được, tương phản tối thiểu 3:1 với nền thanh ở cả giao diện sáng và tối, không trùng màu cảnh báo (điểm nghẽn) hay màu lỗi. Vạch trên thanh tua lại và
  ngăn khoan sâu dùng nó; renderer khi tô theo trạm đọc cùng các biến đó như mọi token khác, không giữ bảng màu riêng.
- **Ngăn trên điện thoại là tấm dưới cao 60dvh** (chủ sở hữu duyệt 23/11/2026), không phải 92dvh như modal theo quy ước modal chung của hệ sinh
  thái: ngăn không modal, phải chừa bản đồ để người xem vẫn thấy cảnh chuyển động và bấm trạm khác.
- **Ngân sách JS lúc khởi động 153,6 KB gzip** (chủ sở hữu duyệt 23/11/2026): 153,5 KB cộng một chunk helper 0,6 KB mà bundler tách ra khi PixiJS vào
  một chunk lazy riêng. PixiJS và cảnh chỉ tải khi mở tab Quan sát; chunk đó có ngân sách riêng (`LIVE_MAP_BUDGET` trong `apps/web/test/perf/budgets.ts`).

### Dữ liệu trên máy

- **Trạm tính trong bộ lọc riêng tư**, nơi payload gốc còn trong bộ nhớ, không phải lúc ghi DB: spool chỉ còn tên chương trình và hai phần cuối đường
  dẫn, không đủ để tách kiểm thử với build, commit với push hay deploy, hay nhận tệp bộ nhớ. Kết quả là các trường dẫn xuất `station`, `station_flags`,
  `target_key`, `read_offset`/`read_limit` và số todo (chờ, đang làm, xong), có mặt cả khi dự án tắt nội dung. Cột `office_room` ngừng ghi; dòng cũ
  được đổi sang trạm lúc đọc từ tên tool và đích đã lọc, đánh dấu "ước lượng".
- **`target_key`** phân biệt hai tệp mà không nêu tên: HMAC-SHA-256 của đường dẫn đầy đủ (thư mục nhà thành `~`) dưới muối riêng của máy, cắt 16 byte.
  Muối 32 byte ngẫu nhiên nằm trong thư mục dữ liệu Observatory (quyền 0600), không bao giờ xuất, `wipe` xoá cùng DB. Khoan sâu vẫn chỉ hiện
  `thư mục/tên`.
- **Schema v2 chỉ thêm** (cột của `tool_calls`, bảng `session_events` và `bottlenecks`, chỉ mục); bảng `meta` giữ `min_reader_version` = 1. Agent bản
  trước mở được DB v2 và chỉ ghi bảng nó biết, nên lùi agent không cần `wipe` và không mất dữ liệu.
- **Khung sự kiện không bao giờ mang nội dung**, dù đọc từ DB hay từ đuôi spool: chỉ nhãn, số, id và đích đã lọc của tool (`thư mục/tên`, tên
  miền, tên chương trình, `server › tool`). Hai trường là đường dẫn đầy đủ, chỉ đổi thư mục nhà thành `~` (ngoài thư mục nhà thì vẫn tuyệt đối):
  `cwd` của phiên và `file_path` của tệp hướng dẫn đã nạp (cũng nằm trong id sự kiện `instruction:…`). Nội dung (lệnh, đường dẫn, kết quả) thiết bị xin
  theo id sự kiện khi người xem bấm (`ObservatoryContent`), agent đọc từ DB và áp công tắc nội dung của dự án, nên tắt nội dung hay xoá nội dung có
  hiệu lực theo một đường duy nhất.
- **Đọc đuôi spool cho phiên đang xem**: spool trễ 5 đến 75 giây trước khi vào DB, nên khi có thiết bị xem một phiên terminal hay CLI, agent đọc các tệp
  phút chưa nạp và phát sự kiện tạm (không nội dung, không ghi đĩa, không sửa tệp); bản DB thay bản tạm cùng id. Phiên agent chạy qua SDK và phiên nội
  bộ bị bỏ như ở bước nạp.
- **Điểm nghẽn là quy tắc ở agent, có vòng đời**: bảy quy tắc (`tool_slow`, `api_slow_or_limited`, `repeat_read`, `context_high`, `mcp_errors`,
  `subagent_idle`, `cost_spike`) mở, cập nhật và đóng một phát hiện theo điều kiện riêng; chạy sau mỗi lô nạp, trên sự kiện đọc đuôi và theo nhịp
  15 giây cho tool treo và subagent im. Ngưỡng theo khoá (tool, model, server MCP, dự án) có số mẫu tối thiểu và sàn tuyệt đối, chỉnh bằng
  `tunelo observatory thresholds`. Phát hiện mang id sự kiện bằng chứng, không nội dung. `cost_spike` so với p95 các lượt trước của dự án trong
  90 ngày (từ 20 lượt, sàn 1 USD hoặc 2 triệu token); `context_high` chỉ xét khi biết chắc cửa sổ ngữ cảnh của model (chủ sở hữu duyệt 23/11/2026).

### Dây

- **Proto chỉ thêm**: khung Live Map 193–196 (`observatory-wire.md` mục 6). Thông điệp `Office*` và khung 168–170 giữ ở dạng `deprecated`, không bao giờ
  dùng lại số; agent mới trả `OfficeWatch` bằng `ERROR_REASON_UNSUPPORTED_REQUEST`.

## Hệ quả

- Repo không còn Babylon.js, `apps/web/src/office-3d/`, `apps/web/src/machines/office/`, `apps/web/public/office/`, decoder Babylon hay mã văn phòng của
  agent; bản build web nhỏ từ 35,6 xuống 8,8 MB. Cache `office-assets-v1` bị service worker xoá; tài sản Live Map có cache riêng `observatory-assets-v1`.
- App di động đã cài gặp agent mới thì tab Văn phòng báo lỗi tới khi cập nhật (chấp nhận); web, app và agent phát hành cùng một đợt. Lần đầu mở Quan sát
  sau khi cập nhật, app hiện một dòng đóng được "Tab Văn phòng đã được thay bằng Quan sát".
- Phần "Văn phòng" của [ADR 0020](./0020-advisor-mascot-jev.md) (Cố vấn ngồi phòng họp) hết hiệu lực: Live Map không có chỗ cho Cố vấn.
- Live Map chỉ vẽ phiên Claude Code; AI khác không có cảnh.
- Tấm nền hiện là bản tạm cắt từ ảnh khái niệm đã duyệt; tấm nền và sprite vẽ xong thay vào theo tên tệp trong `observatory-assets.json`, không đổi mã.
  Giấy phép: [`asset-licenses.md`](../asset-licenses.md).

## Phương án đã bỏ

- Giữ văn phòng 3D và thêm số liệu vào đó: tài sản nặng, cảnh diễn xuất không khớp việc thật, và mọi tín hiệu mới phải qua luồng riêng của văn phòng.
- WebGPU: cảnh 2D không cần, và thêm một đường renderer phải kiểm trên mọi WebView; WebGL cộng Canvas là đủ.
- Nới CSP cho PixiJS (`'unsafe-eval'`, worker `blob:`): mở rộng bề mặt tấn công của cả app chỉ vì một tab.
- Tính trạm lúc ghi DB: spool không còn đủ thông tin (xem trên).
- Gửi nội dung trong khung sự kiện cho nhanh: công tắc nội dung theo dự án và xoá nội dung sẽ phải áp ở hai đường.
- Tính điểm nghẽn ở web: mỗi thiết bị một kết quả, không có phát hiện cho phiên không ai xem, và không có vòng đời đóng đúng lúc.
