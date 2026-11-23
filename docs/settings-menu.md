# Menu Cài đặt: một kiểu hiển thị cho mọi mục

Áp dụng cho web và app (WebView) của Chat. Đặt 13/11/2026, sau khi mỗi mục từng mở một kiểu: phần lớn hiện bên phải menu, Developer Console và Kiểm duyệt thay cả layout (menu Cài đặt biến mất), Góp ý mở hộp thoại đè lên trang.

## Quy tắc

1. **Mục nội bộ mở trong khung Cài đặt.** Bấm một mục thì nội dung hiện ở vùng bên phải (`.set-main`), menu Cài đặt (`.set-nav`) vẫn ở bên trái và mục đó được đánh dấu đang chọn. Không mục nào thay cả layout, ẩn menu hay mở hộp thoại thay cho trang.
2. **Điện thoại: danh sách rồi trang.** `/settings` chỉ hiện danh sách mục; bấm một mục thì mở trang của nó với nút quay lại danh sách ở đầu (`.set-head`). Mục nào cũng có cùng đầu trang đó.
3. **Mục có nhiều trang con** (Developer Console: danh sách bot, tạo bot, từng bot; Kiểm duyệt: hàng đợi, góp ý, thông báo, nhật ký) vẫn mở trong khung Cài đặt. Trang con điều hướng bằng hàng tab ngang ở đầu vùng nội dung, không dùng sidebar riêng. URL của trang con giữ nguyên (`/console/...`, `/moderation/...`), nhưng render trong khung Cài đặt.
4. **Biểu mẫu là một trang, không phải hộp thoại.** Góp ý là một mục như mọi mục khác. Hộp thoại chỉ để xác nhận một thao tác (xoá, rời nhóm), không để chứa cả một mục.
5. **Trang ngoài mở tab mới và có dấu ↗.** Chỉ cho tài liệu nằm ngoài app (Chính sách quyền riêng tư, Điều khoản). Việc thuộc tài khoản hoandat.com (nơi đang đăng nhập, đổi cách đăng nhập, xoá tài khoản) là link ↗ tới `auth.hoandat.com/account`, đặt trong nội dung của mục liên quan, không thành mục riêng (xem quy tắc 8).
6. **Thao tác một chạm** (Đăng xuất) là nút ở cuối menu, ngăn với mục khác bằng một vạch.
7. **Quyền hạn ẩn mục, không đổi kiểu.** Mục chỉ dành cho người vận hành (Kiểm duyệt) không hiện với người khác; khi hiện thì theo đúng quy tắc 1–3.
8. **Việc của cả tài khoản là link tới auth, không bao giờ là trang trong app.** Nơi đang đăng nhập (danh sách thiết bị, đăng xuất thiết bị khác), cách đăng nhập và xoá tài khoản chỉ quản lý ở `auth.hoandat.com/account` (`#account-sessions`, `#account-sign-in`, `#account-delete`); app chỉ có một dòng link ↗ (Cài đặt › Tài khoản, dựng từ issuer trong `brand.ts`). App chỉ giữ "Đăng xuất" cho thiết bị đang dùng, và đăng xuất đó phải kết thúc grant của thiết bị ở IdP ([ADR 0006](./adr/0006-sign-in-and-chat-sessions.md), 13/11/2026).

## Thêm mục mới

- Thêm một `SettingsTab` (hoặc một trang con của mục có sẵn) và nội dung của nó; không thêm route có layout riêng.
- Nhãn và biểu tượng nằm trong nhóm phù hợp của menu; chữ có đủ vi, en, zh-CN.
- Kiểm cả hai cỡ màn: máy tính (menu trái + nội dung phải) và điện thoại (danh sách → trang có nút quay lại).

## Mục Cố vấn

Cài đặt › Cố vấn (`/settings/advisor`, [`advisor-settings.tsx`](../apps/web/src/screens/settings/advisor-settings.tsx)) theo quy tắc 1–2 như mọi mục, với ba điểm riêng ([ADR 0020](./adr/0020-advisor-mascot-jev.md)):

- **Hồ sơ theo tài khoản, ẩn/hiện theo thiết bị.** Tên, ngoại hình và giọng văn lưu trên server và áp cho mascot, bong bóng, thẻ "Cố vấn nhận định" trên mọi thiết bị; công tắc "Hiện mascot trên thiết bị này" chỉ nhớ trên thiết bị đang dùng (cùng việc với "Ẩn mascot" ở menu của mascot).
- **Một khoá cho cả tài khoản, ghi đè theo máy.** Mục "Khoá TypeSafe" ([`advisor-key-section.tsx`](../apps/web/src/screens/settings/advisor-key-section.tsx)) có một dòng khoá của tài khoản: dán một lần, trang gửi khoá qua kênh mã hoá đầu cuối tới một máy rồi các máy tự chuyển khoá cho nhau đã niêm phong ([`use-advisor-key-sync.ts`](../apps/web/src/advisor/use-advisor-key-sync.ts)); server và trình duyệt không giữ khoá, máy nhận xong thì hiện thông báo "Đã đồng bộ khoá Cố vấn cho <máy>". Dưới đó là từng máy: "Đang dùng khoá của tài khoản", "Khoá riêng" (máy giữ khoá riêng, không nhận khoá chung) hoặc "Chưa có khoá", với "Dán khoá riêng"/"Bỏ khoá riêng" chỉ cho máy đó; máy chạy tunelo cũ hiện "Cần cập nhật tunelo để nhận khoá của tài khoản" và vẫn giữ được khoá riêng. Máy đã có khoá từ trước (chưa có khoá chung) hiện thanh hỏi một lần "Dùng khoá này làm khoá chung cho mọi máy?". Xoá khoá chung xoá ở mọi máy (máy đang tắt xoá khi nối lại, nhờ mốc `key_removed_at` trong hồ sơ); khoá riêng giữ nguyên. Mục chỉ hiện nguồn, dấu vân tay, thiết bị đặt và thời điểm, không bao giờ hiện lại khoá. Xoá khoá xác nhận ngay tại chỗ, không mở hộp thoại thay cho trang (quy tắc 4).
- **Chỗ duy nhất nhắc "Jev"/"TypeSafe"**, và cả mục nằm ngoài vùng bắt copy của Cố vấn (`data-advisor-ignore`), để khoá vừa dán không bao giờ thành gợi ý đính kèm.
