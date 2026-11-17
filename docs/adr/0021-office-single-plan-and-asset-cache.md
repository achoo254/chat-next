# ADR 0021: Văn phòng một mặt bằng bốn khu, tài sản bake theo khu và cache bền

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-17
- Thay phần "toà nhà nhiều tầng" của [ADR 0018](./0018-office-view-babylon-normalized-agent-stream.md) và phần "tầng 4" của [ADR 0019](./0019-office-living-floor-and-resident-talks.md). Phần còn lại của hai ADR (luồng sự kiện chuẩn hoá, bảng phòng và tín hiệu, lịch sống, trò chuyện viết sẵn) giữ nguyên.

## Bối cảnh

Toà nhà bốn tầng buộc người xem chuyển tầng bằng thanh T1–T4 hoặc "Tự theo", người đi giữa tầng phải qua thang máy, và chỉ một tầng
được vẽ tại một thời điểm. Chủ sở hữu muốn thấy cả công ty một lần: mọi phòng, mọi người, không thang máy. Tài sản 3D (khoảng 4 MB cho điện
thoại) cũng nên chỉ tải một lần rồi phục vụ từ máy.

## Quyết định

- **Một mặt bằng 37,5 × 29 m, bốn khu** nối bằng hành lang, mỗi khu giữ nguyên kích thước 18 × 14 m và cách bày phòng cũ (chỉ tịnh tiến):
  `a` Điều hành (Giám đốc, Máy chủ, Làm việc chung, Pantry, Phòng họp, Sảnh), `b` Hồ sơ (Kế hoạch, Thư viện, Bưu phòng) ngay sau `a`,
  `c` Kiểm soát (Bảo vệ, Kiểm toán, QA/ISO) bên phải `a`, `d` Sinh hoạt (Ký túc, Gym, Giải trí) sau `c`. 15 mã phòng, mỗi phòng vẫn một tín hiệu;
  dây (`OfficeRoom`) không mang khu nên không đổi proto hay agent (`tunelo` cũ dùng được ngay). Nguồn sự thật là `office-layout.json` `formatVersion: 2`
  do `tools/office-art/write-office-layout.py` sinh.
- **Bỏ thang máy, thanh tầng, "Tự theo" và hiệu ứng chuyển tầng.** Một đồ thị lối đi (`office-walkways.ts`, dùng chung cho bộ kiểm bố cục và
  bộ tìm đường), đường dài nhất giữa hai nút mà neo dùng không quá 45 m; trần thời gian đi bộ nâng từ 7 lên 12 giây. Trò chuyện giới hạn 2 cuộc
  mỗi khu (`MAX_TALKS_PER_ZONE`). Camera không bao giờ tự đi theo người; một nút "Toàn cảnh / Về khu làm việc" đổi khung. Điện thoại mở vào khu Điều hành.
- **Tường:** chỉ cạnh sau và cạnh phải của cả mặt bằng cao; vách giữa các khu thấp (`lowWalls`, 1,1 m) để khu trước không che khu sau. Bảng treo trên
  vách thấp thành bảng đứng tự do (`decor.wall = "free"`); tranh, đồng hồ, cửa sổ trên vách thấp bị bỏ.
- **Tài sản theo khu:** bốn vỏ GLB, mỗi vỏ một cặp lightmap ngày/đêm (1024 và 2048) và một GLB đồ đạc, bake chung trong MỘT cảnh Blender để bóng nối liền.
  Không dùng một atlas cho cả mặt bằng (64 MB mỗi ảnh khi giải nén ở 4096, mất bậc chất lượng, vượt cỡ texture của một số điện thoại). Bản 2D là một ảnh
  cho cả mặt bằng (2400×1500 desktop, 1600×1600 điện thoại, cuộn được). Định dạng `office-assets.json` v2; bộ đọc từ chối bản lạ và mã băm bố cục lệch,
  bản build cũ gặp v2 rơi về khối giữ chỗ.
- **Đọc được ở mọi mức zoom:** dưới khoảng 25 px CSS mỗi mét ẩn đồ lặt vặt và thu nhãn người rảnh thành chấm (hysteresis tới 28 px); người đang làm
  giữ nhãn và bong bóng. Người ngoài khung dừng hoạt ảnh và không phát tiếng. Đồ dựng bằng script gộp vật liệu màu thường thành màu đỉnh (một primitive
  mỗi model, thêm một cho mỗi vật liệu phát sáng hoặc kim loại).
- **Cache bằng service worker sẵn có, cộng HTTP `immutable`:** tệp tài sản có mã băm nội dung trong tên (`/office/<tên>.<8 hex>.<đuôi>`) nằm trong cache
  `office-assets-v1`, giữ qua các build, lấy từ cache trước; `office-assets.json` hỏi mạng trước và rơi về cache khi offline. nginx trả
  `Cache-Control: public, max-age=31536000, immutable` cho tệp có băm. Rảnh thì tải trước phần còn thiếu và dọn tệp không còn trong danh mục.

## Hệ quả

- Tải lần đầu: lightmap và đồ 3D của cả bốn khu cùng lúc (điện thoại ở bậc 1024 khoảng 3,0 MB cho phần bố cục, cộng nhân vật), thay vì từng tầng; từ lần hai chỉ còn danh mục.
- Ngân sách draw call ở bậc medium (chủ sở hữu chốt 17/11/2026): khung mặc định điện thoại tối đa 100, toàn cảnh tối đa 140 (toàn cảnh cao hơn một tầng vì cả bốn khu cùng vẽ; đo 135 ở toàn cảnh desktop, 15 người). Điện thoại không thu ra quá hai khu. Khung mặc định điện thoại chưa đo trên máy thật.
- Đổi bố cục làm mọi tài sản cũ mất hiệu lực nên bố cục và tài sản lên prod cùng một lần.

## Phương án đã bỏ

- Thu nhỏ phòng cho vừa màn điện thoại: spike đo nhân vật 43,8 px ở khung mặc định, không cần.
- Một lightmap atlas cho cả mặt bằng: xem trên.
- Tắt hẳn khu nằm ngoài khung nhìn để bớt draw call: để dành nếu đo máy thật thấy cần.
