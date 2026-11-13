# ADR 0016: Xoá tài khoản chỉ ở IdP, Chat xoá theo

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-13
- Phía IdP: [ADR 0018 "Xoá tài khoản chỉ ở IdP, mọi app dọn theo"](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0018-account-deletion-fan-out.md) của `auth-next`.

## Bối cảnh

Chat từng có luồng xoá riêng: "Xoá tài khoản chat" ở Cài đặt › Tài khoản (đăng nhập lại 10 phút, gõ username, phải chuyển chủ hoặc xoá mọi nhóm và kênh mình làm chủ trước), giữ 30 ngày để huỷ, màn "đang chờ xoá" khi đăng nhập lại, và "Tự xoá tài khoản chat nếu không dùng" 6, 12 hoặc 24 tháng. Xoá tài khoản ở IdP thì Chat không biết, nên dữ liệu chat nằm lại. Chủ sở hữu chốt ngày 13/11/2026: xoá tài khoản chỉ ở `auth.hoandat.com/account`, xoá ngay không giữ, tài sản dùng chung tự chuyển chủ.

## Quyết định

- Endpoint `POST /api/idp/account-deleted` (package [`accountdeleted`](../../server/internal/accountdeleted/accountdeleted.go)), ngoài `/rpc` như `/api/account-notices` (ADR 0015): không phiên, không Origin, không CORS.
- Body là SET (RFC 8417) IdP ký, `Content-Type: application/secevent+jwt`. Chat kiểm offline bằng JWKS từ discovery (`auth.IdP.VerifySecurityEvent`): ES256, `typ: secevent+jwt` (token đăng nhập, logout hay access token không lọt), `iss`, `aud` = `CHAT_PUBLIC_URL` + đường dẫn, `exp` bắt buộc và chưa qua, có `sub` và `jti`, `events` có `urn:hoandat:auth:event:account.deleted`. Không có secret chung.
- Trả lời (lỗi theo dạng RFC 8935 `{"err": "..."}`):
  - `202`: đã xoá xong, hoặc đã ghi việc xoá bền (`users.deletion_requested_at`) và job hằng giờ làm nốt; cũng `202` cho `sub` không có trong Chat hoặc đã xoá, nên IdP gửi lại bao nhiêu lần cũng vô hại;
  - `400 invalid_request`: body không phải SET (rỗng, quá 16 KiB, không phải một JWS ES256, `typ` khác);
  - `401 authentication_failed`: SET hỏng (chữ ký, `iss`, `aud`, hạn, thiếu `sub`/`jti`/event), để IdP thử lại tới khi cấu hình được sửa;
  - `503` (kèm `Retry-After`) khi chưa có discovery của IdP, `500` khi không ghi được việc xoá; IdP thử lại cả hai.
- Xoá (`privacy.DeleteIdPAccount`): trong một transaction khoá dòng `users` theo `idp_sub` và đặt `deletion_requested_at`, `deletion_reason = 'idp'` (hàng đợi bền; tài khoản bị khoá ngay: phiên nào còn thì chỉ được `GetSelf`, nhận `Unauthenticated`, và đăng xuất; người khác thấy "Tài khoản đã xoá", bot ngừng); rồi thu hồi mọi phiên cùng grant ở IdP, báo cho người cùng chat, và chạy `Erase` ngay, tối đa 90 giây (nginx đợi 120 giây). `Erase` dùng lại logic cũ: rời mọi nhóm và kênh, xoá Cloud của tôi và chat riêng không còn ai, xoá dữ liệu cá nhân, bot và bản xuất, giữ dòng `users` làm tác giả ẩn danh của tin đã gửi cho người khác, nhả username, xoá `idp_sub`. Mỗi bước chạy lại được; các lần `Erase` trong một tiến trình chạy lần lượt (mutex), để lời gọi của IdP và job không cùng làm một tài khoản.
- Nhóm và kênh người bị xoá làm chủ: chuyển cho người còn lại có vai trò cao nhất (admin trước member), cùng vai trò thì người vào sớm nhất; không phải bot, không phải tài khoản đang bị xoá; không còn ai thì xoá nhóm hoặc kênh (`chat.LeaveAllChats`, có sẵn từ trước).
- Bỏ mọi đường xoá phía người dùng: các RPC `GetAccountDeletion`, `SetAutoDelete`, `DeleteAccount`, `CancelAccountDeletion` cùng message của chúng, `GetSelfResponse.deletion` (số 3 và tên `deletion` được `reserved`) và enum `AccountDeletionReason`; job tự xoá khi không dùng; màn "đang chờ xoá" và thẻ xoá ở Cài đặt › Tài khoản, thay bằng một dòng dẫn tới `https://auth.hoandat.com/account#account-delete` (lấy từ `brand.accountUrl`, theo issuer trong `brand.config.json`). Trang công khai `/delete-account` (URL xoá khai với kho ứng dụng) giữ lại và chỉ đường tới IdP.
- Tài khoản còn trong 30 ngày chờ của luồng cũ (`deletion_reason` `user` hoặc `inactive`) được job xoá hẳn ngay lần chạy đầu sau khi deploy: chúng đã bị khoá, và không còn đường huỷ nào.
- SET, `sub` và nội dung không vào log; log chỉ có `user_id` và kết quả (`chat account erased`, `no chat account`, `erasure queued for the job`, `account deletion event rejected`).

## Hệ quả

- Mất đường lùi 30 ngày: chủ ý, một luật cho mọi app (ADR 0018 của IdP).
- Migration `0038` chỉ nới CHECK, tắt `auto_delete_months` và bỏ index của nó; cột `auto_delete_months` còn tới một đợt dọn sau, để binary trước vẫn chạy khi rollback.
- `idp_sub` bị xoá khi xoá hẳn, nên Chat không nhớ `sub` đã xoá. IdP không bao giờ cấp lại `sub` cũ (ADR 0009 của IdP) và đăng nhập tương tác bằng nó là không thể. Còn một khe: access token JWT 15 phút của tài khoản đó (MCP, `tunelo`) cấp trước khi xoá, nếu dùng sau khi Chat đã xoá hẳn, sẽ tạo một người dùng Chat mới rỗng mang `sub` cũ, và IdP không gửi SET lần nữa. Chấp nhận vì cửa sổ ngắn và người dùng đó không có dữ liệu; muốn đóng hẳn thì phải giữ danh sách `sub` đã xoá.
- Proto bỏ RPC và message có chủ ý: `proto/buf.yaml` tạm bỏ qua `RPC_NO_DELETE`, `MESSAGE_NO_DELETE`, `ENUM_NO_DELETE`, `FIELD_NO_DELETE` cho `privacy.proto` và `users.proto`; khối đó phải gỡ ở commit ngay sau commit bỏ chúng, như lần Tunelo 3.0. Client cũ gọi RPC đã bỏ nhận `unimplemented`.
- nginx có `location = /api/idp/account-deleted`; conf đổi nên lần đầu phải cài bằng root. IdP phải có URL này trong `ACCOUNT_DELETED_URLS`.
