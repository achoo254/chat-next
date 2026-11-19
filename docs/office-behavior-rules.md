# Văn phòng 3D: luật hành vi của 15 người

Đội hình cố định 15 người (Giám đốc điều hành, Cố vấn và 13 chức danh) luôn hiện đủ trên một mặt bằng; không ai biến mất khi không có subagent.
Mỗi người có phòng nhà (trường `home` của neo trong `office-layout.json`, sinh từ `tools/office-art/write-office-layout.py`).
Đặt chỗ nằm ở `apps/web/src/machines/office/office-placement.ts` và `office-life-schedule.ts`; đội hình ở `office-cast.ts`.

Giờ hành chính = khung `work` của lịch sinh hoạt hiện có (08:00–12:00 và 13:00–17:30 theo đồng hồ người xem, lệch ±20 phút theo từng người).
"Agent chạy" = phiên đang bận (`session.busy`) hoặc có hoạt động công cụ đang diễn ra.

| Tình huống | Hành vi |
|---|---|
| Trong giờ hành chính | Mọi người ở trạm của phòng nhà, dù rảnh (không đi giải trí) |
| Ngoài giờ và không có agent chạy | Nghỉ ngơi, giải trí, ngủ theo lịch hiện có; trừ Kỹ sư IT (ngồi trạm, gật gù ban đêm) |
| Có agent chạy (bất kể giờ) | Người của phòng chứa hoạt động đó làm việc, ai đang ở ký túc/giải trí quay về phòng nhà; hoạt động đi tới phòng nào thì người có phòng nhà là phòng đó thực hiện |
| Giám đốc | Ngồi một chỗ ở phòng Giám đốc; chỉ đi kiểm tra các phòng, đi họp, nghỉ ngơi và giải trí (ngoài giờ, không agent chạy). Không làm việc của bộ phận khác. Vẫn đồng bộ với AI thực thi thật nhưng ở vai người chỉ đạo: khi agent chính nhận yêu cầu hoặc giao việc thì Giám đốc chỉ tay giao cho cấp dưới (hoạt động `delegate`), nhân viên của phòng liên quan nhận việc và chạy; Giám đốc không gõ máy, không đọc, không sửa |
| Hỏi Cố vấn | Người hỏi đi tới phòng Cố vấn rồi về |
| Kế toán | Ngồi một mình ở phòng Kiểm toán (`audit-work-1`), quay về bảng token vào/ra; cập nhật số mỗi cuối lượt |
| Lập trình viên, thiết kế, sửa lỗi | Ngồi làm việc trên máy tính ở WORK; khi có lệnh liên quan thì sang phòng kế hoạch (PLANNING) hoặc phòng họp (MEETING) thường xuyên, xong thì về bàn. Không đứng thường xuyên ở phòng máy chủ |
| QA Tester | Ngồi ở bàn của phòng QA/ISO (`qa-work-1`), không ngồi chung ở WORK; lệnh kiểm thử chạy thì làm ngay tại chỗ |
| Phòng máy chủ | Chỉ Kỹ sư IT (system admin / devops) đứng thường xuyên; người khác chỉ ghé khi có lệnh máy chủ |
| Cần duyệt quyền | Chuyên viên bảo mật đón ở cửa (phòng SECURITY), Chủ tịch ở sảnh |

## Tư thế nằm và ngủ

Người ngủ dùng clip `Sleeping_Side` (cuộn nghiêng); điểm thấp nhất của da luôn được đặt chạm nệm, bất kể model (`skinned-character.ts`, đo một lần sau khung hình đầu tiên của tư thế ngủ). Người nằm dựa (`Lying_Lounge`) dùng clip đã hạ sẵn khi dựng. `apps/web/test/e2e/office-fit.e2e.ts` kiểm cả hai trên cả 15 người: lệch nệm dưới 0,04 m và thân nằm gọn trong giường.

## Nghiệm thu

Các dòng E1–E33 của `acceptance.md`; ADR liên quan: `adr/0019-office-living-floor-and-resident-talks.md`, `adr/0021-office-single-plan-and-asset-cache.md`.
