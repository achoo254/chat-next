# Tài liệu

Thư mục này giữ phần "vì sao" và "ở đâu" của dự án. Cách làm cụ thể nằm trong code, test, `proto/` và `spec/`; khi tài liệu và nguồn đó lệch nhau, nguồn đó đúng và tài liệu phải sửa.

## Quyết định kiến trúc (ADR)

Mỗi ADR trong [`adr/`](./adr/) ghi một quyết định mà sửa về sau phải migrate dữ liệu hoặc phá vỡ client, cùng lý do, hệ quả và cách thay đổi an toàn.

| ADR | Tóm tắt |
|---|---|
| [0001 Sơ đồ định danh](./adr/0001-id-scheme.md) | Mọi id lộ ra ngoài nhỏ hơn 2^53; tin nhắn lộ ra bằng `(chat_id, seq)`, Snowflake chỉ dùng nội bộ. |
| [0002 Đồng bộ update](./adr/0002-sync.md) | `pts` theo người dùng, `chat_pts` cho chat `large`, `GetDifference`/`GetChatDifference`, `too_long`, `server_epoch` và các quy tắc đồng bộ phía client. |
| [0003 Outbox](./adr/0003-outbox.md) | Log outbox ghi trong cùng transaction, partition theo ngày, enum `kind` đầy đủ, cursor theo consumer, giao ngay sau commit cộng sweeper. |
| [0004 Định dạng văn bản](./adr/0004-text-format.md) | `text + entities[]` với offset UTF-16, allowlist scheme URL, giới hạn độ dài theo code point. |
| [0005 Fold tiếng Việt](./adr/0005-vietnamese-fold.md) | Một hàm bỏ dấu có đặc tả và test vector dùng chung cho TypeScript và Go. |
| [0006 Đăng nhập và phiên chat](./adr/0006-sign-in-and-chat-sessions.md) | Đăng nhập chỉ qua `auth-next`; phiên chat riêng của app nhưng chết theo grant của IdP. |
| [0007 Topology client](./adr/0007-client-topology.md) | Web chạy sync và SQLite trong worker; native chạy sync trên main thread và đẩy việc nặng xuống native theo lô. |
| [0008 Branding và đặt tên](./adr/0008-branding-and-naming.md) | `brand.config.json` là nguồn duy nhất cho tên, màu, scheme, domain; tên tenant lấy từ IdP. |
| [0009 Lưu trữ local](./adr/0009-local-storage.md) | SQLCipher trên native, cache không mã hoá trên web, dữ liệu local tách theo `(tenant, user)`. |
| [0010 Tenant theo domain](./adr/0010-tenants-by-domain.md) | Host `chat.<d>` chọn tenant, `tenant_id` từ migration đầu, Mini App và media trên domain đăng ký riêng. |
| [0011 Phiên native, bearer và CORS](./adr/0011-native-sessions-bearer-cors.md) | App iOS/Android đổi code qua `ExchangeNativeCode`, xác thực bằng bearer (hello ở `/ws`), CORS và origin WebView chỉ cho bearer, không bao giờ cho cookie. |

Đổi một quyết định: viết ADR mới mang số kế tiếp, ghi ADR cũ là "Bị thay thế bởi ADR NNNN" trong dòng trạng thái, và làm theo mục "Cách thay đổi" của ADR cũ.

## Đặc tả

- [Fold tiếng Việt](../spec/vi-fold/SPEC.md): đặc tả và bộ test vector mà bản TypeScript và Go cùng phải pass.
- [Bot API](../spec/bot-api/openapi.yaml) (OpenAPI 3.1, kèm [`format.md`](../spec/bot-api/format.md)); bắt đầu nhanh cho người viết bot: [`bot-api/`](./bot-api/README.md) (token, long poll, webhook, kiểm chữ ký HMAC).

## Quyền riêng tư

- [Danh mục dữ liệu cá nhân](./privacy/data-inventory.md): dữ liệu app chat giữ, nơi lưu, thời hạn, cơ sở pháp lý (Nghị định 13), xuất và xoá dữ liệu.
- [Trang chính sách công khai](./privacy/legal-pages-draft.md) (`/privacy`, `/terms`, `/delete-account`): Jev duyệt phát hành 20/10/2026, từng khẳng định kèm nguồn và các mục còn thiếu.

## App mobile

- [App iOS và Android](./mobile-app.md): build, chạy, luồng đăng nhập, khác web và phần chưa làm.

## Vận hành

- [Xoay vòng khoá](./operations/key-rotation.md): đổi `SESSION_KEY` không đăng xuất ai (`SESSION_KEY_PREVIOUS`, role `reseal`), đổi secret OIDC, mật khẩu database, và các khoá không được đổi.

## Kế hoạch

Kế hoạch triển khai và nhật ký quyết định nằm ở [`plans/dattqh/261013-0448-chat-platform-v1/plan.md`](../plans/dattqh/261013-0448-chat-platform-v1/plan.md). Đó là bản ghi theo thời điểm, không phải tài liệu thường trực; khi plan và ADR khác nhau, ADR là quyết định hiện hành.
