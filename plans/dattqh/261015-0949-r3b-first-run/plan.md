# R3b — Người dùng mới: Cloud của tôi và mời đồng đội

Status: In progress · Tier L (backend, core, web, mock) · Plan gốc: [chat-platform-v1](../261013-0448-chat-platform-v1/plan.md) (hàng R3b), mock `chat.html#first-run`.

## Outcome

Người dùng mới không bao giờ thấy danh sách chat trống hoàn toàn và có đường mời cả nhóm vào ngay.

## Quyết định (Jev, 2026-10-15)

| Điểm | Chọn | Xác suất |
|---|---|---|
| Mô hình "Cloud của tôi" | Chat riêng với chính mình: `private_chats` có `user_low = user_high`, một dòng `chat_members`; client nhận ra khi peer = chính mình; không đổi proto | 0.77 |
| Người dùng đã có | Tạo khi cần, idempotent, ở `GetSelf` (mỗi lần mở app), không cần đăng nhập lại | 0.69 |
| Giới hạn 5 chat ghim | Cloud của tôi không tính vào giới hạn | 0.99 |
| Nút "Tạo nhóm và mời" | Hộp thoại Tạo nhóm thường, cho phép không chọn ai, xong hiện hộp thoại link mời | 0.63 (khác mock: sửa mock trước) |

## Phần việc

1. Server: migration nới `CHECK (user_low <= user_high)`; `EnsureSavedChat` tạo và ghim chat (ghi `pinned_dialogs` update để mọi máy biết); `GetSelf` gọi nó; `CreatePrivate(me, me)` trả chat đó; đếm giới hạn ghim bỏ qua nó.
2. Web: tên "Cloud của tôi" và avatar cloud cho chat có peer là chính mình; không hiện đã xem, đang gõ, trạng thái hoạt động; mục "Lưu vào Cloud của tôi" trong menu tin (ẩn khi đang ở chính chat đó); màn trống "Mời đồng đội vào cùng" khi chỉ có Cloud của tôi; tạo nhóm không cần chọn ai rồi hiện link mời.
3. Mock: hộp thoại tạo nhóm ở `#first-run-invite` có ô chọn người, cho phép không chọn ai.
4. Kiểm tra: test Go cho `EnsureSavedChat`, giới hạn ghim, `CreatePrivate(me, me)`; test web; kịch bản E2E `first-run`.

## Acceptance

- Đăng nhập lần đầu hoặc mở lại app: có "Cloud của tôi" ghim đầu danh sách trên mọi máy.
- Ghim thêm đủ 5 chat khác vẫn được; bỏ ghim Cloud của tôi được.
- Lưu một tin từ chat khác vào Cloud của tôi, máy thứ hai thấy.
- Tài khoản mới: màn trống có "Tạo nhóm và mời"; tạo nhóm không chọn ai rồi có link mời; người khác mở link vào được nhóm.
- Lint, typecheck, test Go/core/web, `pnpm e2e` xanh.
