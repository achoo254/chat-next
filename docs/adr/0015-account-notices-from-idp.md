# ADR 0015: Thông báo bảo mật của IdP qua bot trợ lý

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-13
- Phía IdP: [ADR 0017 "Thông báo bảo mật qua app Chat"](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0017-account-notices-in-chat.md) của `auth-next`.

## Bối cảnh

IdP (`auth.hoandat.com`) muốn gửi thông báo bảo mật của tài khoản (đăng nhập mới, thêm hoặc gỡ cách đăng nhập, …) vào Chat mà người dùng không phải liên kết gì. Mỗi người dùng Chat đã lưu mã tài khoản IdP (`users.idp_sub`), và Chat có sẵn bot trợ lý hệ thống nhắn riêng cho từng người.

## Quyết định

- Endpoint `POST /api/account-notices` (package [`accountnotice`](../../server/internal/accountnotice/accountnotice.go)), ngoài `/rpc`: không phiên, không Origin, không CORS, như `/machine-api/`.
- Body `{"text": "..."}`: cắt khoảng trắng hai đầu, 1–2000 ký tự UTF-8, body tối đa 8 KiB. Chữ do IdP viết sẵn theo ngôn ngữ của tài khoản; Chat không dịch.
- Xác thực bằng access token IdP tự ký: `VerifyAccessToken` với `aud` = `CHAT_PUBLIC_URL` + `/api/account-notices` (ES256, `typ: at+jwt`, issuer, hạn), rồi đòi `client_id` = `auth-account-notices` và scope `account-notices`. Không có secret riêng giữa hai máy chủ.
- Trả lời: thiếu hoặc sai token `401 {"error":"invalid_token"}` kèm `WWW-Authenticate: Bearer`; sai client hoặc scope `403 {"error":"insufficient_scope"}`; chữ sai `400 {"error":"invalid_request"}` (quá 8 KiB thì `413`); quá 30 thông báo một phút cho một tài khoản `429 {"error":"rate_limited"}`; IdP chưa sẵn sàng `503`; gửi lỗi `502`.
- Tài khoản không có người dùng Chat, trợ lý đang tắt, người dùng đã chặn trợ lý hay xoá chat với nó: đều `204` và không gửi gì, giống hệt khi gửi thành công, để IdP không dò được ai có tài khoản Chat.
- Gửi bằng `assistant.NotifyAccount`: mở chat với trợ lý nếu người dùng chưa bấm Bắt đầu (như thông báo kiểm duyệt), rồi gửi qua Bot API nội bộ, nên giới hạn và quyền riêng tư của bot vẫn áp dụng.
- Token, nội dung thông báo và `sub` không vào log; log chỉ có `user_id` và mã lỗi.

## Hệ quả

- Lộ khoá ký của IdP thì mất cả hệ thống; endpoint không thêm bề mặt mới. Token bắt lại trong 60 giây chỉ gửi trùng một tin cho chính chủ; Chat không lưu `jti`.
- nginx có `location = /api/account-notices` tới API (không cookie, body nhỏ); conf đổi nên lần đầu phải cài bằng root, thiếu nó thì request rơi vào web tĩnh.
