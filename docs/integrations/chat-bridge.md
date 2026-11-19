# Chat Bridge: đưa chat của ứng dụng khác vào Chat

Chat Bridge đồng bộ các cuộc trò chuyện của chính bạn ở một ứng dụng khác vào Chat để đọc, tìm kiếm và nhận tin mới theo thời gian thực, và (tuỳ từng chat) gửi tin bạn gõ trong Chat sang ứng dụng đó. Telegram là ứng dụng đầu tiên. Quyết định và lý do: [ADR 0022](../adr/0022-chat-bridge.md). Vận hành: [`operations/chat-bridge.md`](../operations/chat-bridge.md).

**Hai chiều, bật từng chat.** Tin luôn đi từ ứng dụng kia sang Chat. Chat bật **Gửi tin từ Chat** thì tin bạn gõ ở đó cũng được gửi sang ứng dụng kia như tin do chính bạn gửi; chat tắt thì bị khoá ô soạn tin (server bỏ quyền gửi, nên cả Bot API và MCP cũng không gửi vào được).

## Dùng

1. Người vận hành bật tính năng và cấp `api_id`, `api_hash` ([Cấp api_id](#cấp-api_id-và-api_hash)).
2. Cài đặt › **Kết nối ứng dụng** › Telegram › Kết nối. Nhập số điện thoại kèm mã quốc gia, mã đăng nhập Telegram gửi tới app trên thiết bị khác của bạn (hoặc SMS), và mật khẩu hai bước nếu tài khoản có. Chỉ bước đăng nhập này đòi đăng nhập Chat trong 10 phút gần đây (nó cấp quyền đọc cả tài khoản); nếu không trang đưa sang đăng nhập lại. Bật chat, bật hay tắt gửi tin, xoá bản sao và ngắt kết nối không đòi.
3. **Hiện danh sách chat**, bấm **Đồng bộ** ở chat muốn lấy, chọn số tin gần nhất cần tải (200, 500, 2.000 hoặc 10.000; mặc định 2.000) rồi **Bắt đầu đồng bộ**.
4. Lịch sử nhập dần, đúng thứ tự thời gian gốc, không báo thông báo đẩy và không tính tin chưa đọc. Tin mới, tin sửa và tin xoá bên Telegram về sau vài giây.
5. Ô **Gửi tin từ Chat sang Telegram** ở bước chọn mặc định bật: chat mới gửi được hai chiều. Bỏ tích để chat chỉ đọc. Chat đã đồng bộ từ trước giữ nguyên cách cũ; bật hoặc tắt từng chat bằng công tắc **Gửi tin từ Chat** cạnh chat đó.

## Gửi từ Chat sang Telegram

Chat hai chiều hiện ghi chú "Tin bạn gõ ở đây cũng được gửi sang Telegram" trên ô soạn tin. Gửi được: văn bản có định dạng (đậm, nghiêng, mã, liên kết), trả lời, sửa, xoá cho mọi người, ảnh, tệp và album. Xoá chỉ cho tôi chỉ xoá ở Chat. Chuyển tiếp, bot, Bot API và thành viên khác không gửi sang Telegram được.

Mỗi tin gửi đi có trạng thái ngay trên tin: đồng hồ là đang gửi (Chat xếp hàng và gửi từng tin, cách nhau chừng 0,7 giây, theo đúng thứ tự). Lỗi hiện thành dòng "Chưa gửi sang Telegram" kèm **Gửi lại** và **Xoá tin** (xoá là cách bỏ tin gửi hỏng). Tạm mất mạng hoặc Telegram bảo chờ thì Chat tự thử lại, không mất tin và không gửi trùng. Nếu server dừng đúng lúc đang gửi và quá 10 phút mới chạy lại, tin hiện "Chưa rõ đã gửi sang Telegram chưa": kiểm trong Telegram rồi chọn **Gửi lại** hoặc **Xoá tin**. Bản sửa không sang được (ví dụ Telegram không cho sửa tin cũ nữa) hiện "Bản sửa chưa sang Telegram" kèm **Gửi lại** và **Bỏ qua**.

## Ghim

- **Từ Telegram sang Chat:** khi bật đồng bộ, các tin đã ghim ở Telegram (nằm trong cửa sổ lịch sử đã nhập) được ghim trong Chat; ghim và bỏ ghim tin, ghim và bỏ ghim topic ở Telegram hiện sang Chat ngay. Chat đồng bộ từ trước nhận ghim khi server chạy lại. Tin ghim cũ hơn cửa sổ lịch sử không có trong Chat nên không ghim được (nhóm làm việc thường ghim tin rất cũ). Chat không thêm dòng "đã ghim" cho ghim đến từ Telegram.
- **Từ Chat sang Telegram (chat hai chiều):** ghim, bỏ ghim tin và **ghim topic** (menu chuột phải của topic chỉ còn mục Ghim) đổi theo ở Telegram, im lặng (không báo thành viên). Cần quyền ghim ở nhóm Telegram. Nếu Telegram từ chối (không phải quản trị viên, ghim quá nhiều) thì Chat trả ghim về như cũ và báo "Telegram không cho ghim…". Chat chỉ đọc giữ ghim riêng trong Chat, không gửi gì ra ngoài. Tên, màu, đóng và ẩn topic vẫn chỉ đổi ở Telegram.
- Sau khi ghim tin từ Chat, Telegram đăng một dòng "đã ghim tin nhắn" trong nhóm cho mọi người thấy; bỏ ghim thì không có dòng nào.

## Tính năng của từng chat

Mỗi chat đã đồng bộ có nút **Tính năng** (Cài đặt › Kết nối ứng dụng): mỗi tính năng nền tảng hỗ trợ chọn Tắt, Chỉ nhận, Chỉ gửi hoặc Hai chiều, và có mức nhanh Chỉ đọc, Cá nhân, Đầy đủ. Hướng mặc định của tính năng theo hướng của tin nhắn (chat gửi tin thì ghim, tắt tiếng, tên nhóm cũng đi hai chiều). Tính năng tác động lên người và nhóm (thành viên, link mời) tắt mặc định và hỏi xác nhận khi bật. Thêm nền tảng: [Thêm một nền tảng chat](adding-a-platform.md).

- **Trạng thái chat trong danh sách của bạn** (tắt tiếng, ghim chat, đánh dấu chưa đọc): Chat đọc từ Telegram mỗi 2 phút và làm Chat khớp với Telegram; đổi trong Chat thì gửi sang Telegram (chỉ trạng thái cuối). Ghim chat quá 5 của Chat bị bỏ qua.
- **Tên và mô tả nhóm:** đọc mỗi khoảng 10 phút; đổi trong Chat gửi sang Telegram (cần quyền đổi thông tin nhóm). Chat không đăng dòng "đã đổi tên" cho thay đổi đến từ Telegram vì không biết ai đổi. Ảnh nhóm chưa đồng bộ.
- **Topic từ Chat:** tạo topic mới (tên và màu), đổi tên, đóng và mở lại, ghim đi sang Telegram khi tính năng Chủ đề gửi ra; tin gõ vào topic vừa tạo chờ topic có ở Telegram rồi mới đi. Biểu tượng tuỳ chỉnh, đổi màu sau khi tạo và ẩn vẫn chỉ làm ở Telegram.
- **Telegram từ chối** (không đủ quyền…): Chat trả về như Telegram đang có và báo một thông báo.
- **Thành viên, link mời, rời và xoá nhóm (tính năng tác động lên người, tắt mặc định, bật riêng từng chat ở bảng tính năng và hỏi xác nhận):**
  - **Chiều vào** (chỉ nhận): người vào, ra, được phong admin và bị hạn chế quyền ở Telegram hiện thành thành viên và quyền trong Chat (mỗi khoảng 10 phút; nhóm quá 1.000 người chỉ thêm, không bớt); danh sách link mời của Telegram hiện ngay trong bảng.
  - **Chiều ra** (chỉ gửi hoặc hai chiều): xoá người khỏi nhóm (họ vào lại được), phong và gỡ admin (quyền: xoá tin, mời người, ghim), **thêm một người** (chọn trong những người tài khoản đã gặp và chưa ở trong nhóm; họ có thể từ chối theo cài đặt riêng tư), **đổi quyền từng người** (cấm gửi tin, ảnh và tệp, mời người, ghim, đổi thông tin, quản lý chủ đề; chỉ nhóm lớn), **tạo và thu hồi link mời của Telegram** (không phải link vào Chat).
  - **Rời nhóm và xoá nhóm** (tính năng «Rời và xoá nhóm», chỉ gửi): cần đăng nhập lại trong 10 phút, gõ lại đúng tên nhóm; xoá nhóm còn phải chờ 10 giây rồi xác nhận lần hai bằng mã dùng một lần, chỉ chủ nhóm ở Telegram làm được, và tối đa một lần mỗi giờ. Sau khi rời hoặc xoá, bản sao trong Chat được giữ lại và chuyển sang chỉ đọc. Xoá nhóm xoá cả lịch sử của mọi người ở Telegram và không lấy lại được.
  - **Hàng rào chung:** chỉ với người của Telegram (thành viên chỉ có ở Chat không bao giờ bị gửi đi); mỗi lần gửi ghi nhật ký (xoá nhóm ghi trước khi gửi); giới hạn 10 hành động mỗi giờ mỗi tài khoản; nếu Telegram từ chối thì Chat đọc lại và trả về như Telegram.

Chat đã đồng bộ hiện nhãn nhỏ tên ứng dụng ở danh sách. Người gửi hiện bằng tên của họ ở Telegram; tin của chính bạn bên Telegram hiện là tin của bạn.

- **Thông báo tin mới** (tắt mặc định): khi bật cho một chat, tin mới của người khác ở Telegram báo trong Chat như tin thường (đẩy thông báo và số chưa đọc), theo đúng cài đặt tắt tiếng, loại chat, xem trước và người bị chặn. Lịch sử nhập lúc đầu và tin do chính bạn gửi từ Telegram không bao giờ báo.
- **Dòng hệ thống của Telegram** (ai vào, rời, bị xoá, vào bằng link, tạo nhóm, đổi tên, đổi ảnh nhóm, ghim tin): nhập thành dòng hệ thống của Chat đúng chỗ trong dòng tin, theo người làm. Đồng bộ thành viên không còn tự đăng dòng «đã rời» để khỏi trùng. Dòng ghim một tin Chat không có thì bỏ qua.
- **Biểu cảm (reaction) hai chiều:** reaction của người ở Telegram hiện trên tin trong Chat dưới tên họ, reaction của bạn ở Telegram là của bạn trong Chat; bạn thả hoặc bỏ reaction trong Chat thì Telegram làm theo (chỉ trạng thái cuối). Đến bằng sự kiện, và cứ khoảng 10 phút Chat đọc lại 50 tin mới nhất của mỗi chat cho những gì Telegram không báo. Chỉ emoji chuẩn: emoji tuỳ chỉnh và reaction trả phí không có ở Chat. Nhóm lớn Telegram chỉ cho biết vài người thả gần nhất: Chat thêm những người đó nhưng không xoá ai. Telegram từ chối (emoji nhóm không cho phép, cần Premium) thì Chat trả về như Telegram.
- **Đã đọc hai chiều:** đọc ở Chat thì Telegram đánh dấu đã đọc; đọc ở thiết bị khác của Telegram thì vị trí đã đọc trong Chat dời theo; ở chat riêng thấy người kia đã đọc. Chủ đề diễn đàn chưa đọc theo từng chủ đề.
- **Mặc định cho chat mới và «Lỗi đồng bộ»:** ở trang tài khoản chọn mặc định theo tính năng cho chat sẽ đồng bộ (tích «áp luôn cho tất cả chat» để đổi cả chat đã đồng bộ; tin nhắn và nhóm tác động lên người không có mặc định). «Lỗi đồng bộ» gom mọi thao tác Chat gửi sang Telegram mà không thành công, có lý do, thử lại và bỏ qua.

## Nhóm có chủ đề (forum)

Nhóm Telegram bật chủ đề đồng bộ thành **nhóm dạng forum** trong Chat: mỗi topic của Telegram là một topic của Chat (topic mặc định là General), tin về đúng topic, topic mới, đổi tên, đổi màu, đóng và ghim ở Telegram phản ánh sang Chat. Ở danh sách chọn chat, nhóm như vậy có nhãn **Nhóm có chủ đề**; chat đã đồng bộ có nhãn **Có chủ đề**.

- **Gõ trong topic nào thì tin vào đúng topic đó bên Telegram** (nếu chat bật Gửi tin từ Chat). Topic đã đóng hoặc đã xoá bên Telegram thì tin báo lỗi như các lỗi gửi khác, các tin sau vẫn đi.
- **Topic do Telegram quản lý:** tạo, đổi tên, đổi màu, đóng, ẩn topic chỉ làm ở Telegram; ở Chat các thao tác đó bị chặn và không còn menu. Ghim topic là ngoại lệ ở chat hai chiều (xem [Ghim](#ghim)).
- **Nhóm đã đồng bộ từ trước (trước khi có chủ đề) vẫn là một dòng tin trộn các topic.** Muốn tách: ở danh sách chọn chat bấm **Đồng bộ lại theo chủ đề** (xoá bản sao rồi bật lại với cùng cửa sổ lịch sử và cùng hướng gửi; những gì chỉ có ở Chat sẽ mất).
- **Cửa sổ lịch sử vẫn áp cho cả nhóm:** topic chỉ có tin cũ hơn cửa sổ thì có mặt (danh sách topic được nạp đủ) nhưng rỗng cho tới khi có tin mới.
- **Nhóm quá 1.000 topic** (giới hạn của Chat): tin của topic thừa vào General, đồng bộ vẫn tiếp tục.

## Giới hạn

- **Không tải thêm lịch sử cũ.** Thứ tự tin trong Chat chỉ nối vào cuối (`seq`), nên cửa sổ lịch sử chọn một lần lúc bật và không đổi được. Muốn khác thì xoá bản sao và đồng bộ lại.
- **Tệp:** ảnh, video, thoại, âm thanh và tệp tới 25 MiB được sao chép vào kho media của bạn (tính vào hạn mức lưu trữ). Lớn hơn, nhãn dán, vị trí, danh bạ và bình chọn chỉ hiện một dòng chữ như `[Ảnh]` hay `[Tệp: tên.pdf]`.
- **Định dạng chữ:** giữ đậm, nghiêng, gạch chân, gạch ngang, spoiler, mã, khối mã, link, email, hashtag và nhắc tên người đã xuất hiện trong chat. Link `tg://`, lệnh bot và số điện thoại bị bỏ định dạng; tin dài quá giới hạn của Chat bị cắt.
- **Chat bí mật (E2E) của Telegram không đồng bộ được**; "Tin nhắn đã lưu" không được nhập.
- **Người liên hệ là người dùng ảo:** mỗi người bên Telegram là một tài khoản ảo trong Chat, không đăng nhập được, không ai tìm, nhắn hay thêm vào nhóm được. Chưa có ảnh đại diện của họ (hiện chữ cái đầu).
- **Gửi:** kênh Telegram chỉ đăng được khi bạn là quản trị viên, nhóm hay người dùng cấm bạn thì tin báo lỗi kèm lý do. Văn bản tối đa 4.096 ký tự (chú thích tệp 1.024), tệp tối đa 2.000 MB và còn chịu hạn mức tệp của Chat. Album chỉ mang chú thích của tệp đầu. Mention chỉ thành mention thật với người đã có trong danh sách hội thoại của bạn; còn lại giữ nguyên chữ.
- **Phiên Telegram:** Chat là một thiết bị trong danh sách thiết bị của bạn. Chat tôn trọng giới hạn tốc độ của Telegram (chờ đúng thời gian Telegram yêu cầu). Nếu bạn kết thúc phiên đó ở Telegram, tài khoản chuyển "Cần đăng nhập lại".
- **Không lưu số điện thoại và mã.** Chỉ phiên đăng nhập đã mã hoá (khoá `SESSION_KEY`, gắn với tài khoản của bạn) được giữ.

## Ngắt kết nối và xoá

- **Xoá bản sao** của một chat: xoá chat đó khỏi Chat, bản gốc ở Telegram không đổi.
- **Ngắt kết nối**: đăng xuất phiên Chat ở Telegram. Chọn giữ các chat (chỉ đọc, hàng đợi gửi chưa đi bị bỏ) hoặc xoá hết chat cùng các liên hệ đã nhập (họ mất tên và ảnh).
- **Tắt gửi** ở một chat: tin đang chờ trong hàng đợi bị bỏ; tin đã gửi sang Telegram giữ nguyên ở đó.
- **Xoá tài khoản hoandat.com** xoá cả phiên Telegram (đăng xuất qua hàng đợi), chat đã đồng bộ và người dùng ảo.

## Cấp api_id và api_hash

Một lần cho cả hệ thống, bởi người vận hành, bằng tài khoản Telegram: đăng nhập `my.telegram.org`, mục "API development tools", tạo ứng dụng và lấy `api_id`, `api_hash`. Đặt vào `/opt/chat/.env` (không vào repo): `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`; `api_hash` là bí mật, không in ra log hay gửi cho client.

## Thêm một ứng dụng khác

Lõi Chat không đổi khi thêm ứng dụng. Việc cần làm:

1. Viết gói adapter cài `bridge.Adapter` ([`server/internal/bridge/adapter.go`](../../server/internal/bridge/adapter.go)): `Name`, `Capabilities` (`history`, `live`, `edits`, `deletes`, `media`, `send` chỉ khai những gì có thật), `Login` (chuỗi bước `input`, `qr`, `confirm`, kết thúc bằng `done` kèm phiên để server niêm phong; trả `*bridge.InputError` khi người dùng nhập sai), `Logout`, `ListConversations`, `Backfill` (một trang lịch sử cũ hơn con trỏ, mới nhất trước), `Subscribe` (luồng sự kiện cả tài khoản; mỗi `Event` mang trạng thái update sau nó dưới dạng blob mờ do adapter sở hữu; trả `ErrGapTooLarge` khi không phát lại được khoảng hở) và `FetchMedia`. Nhóm có topic: cài thêm `bridge.TopicReader` (`ListTopics`), khai `topics`, đặt `Conversation.Forum`, `Message.Topic` và gửi `Event.Topic` khi topic đổi; Chat giữ ánh xạ id topic của app sang id topic của mình (`external_topics`), nên id topic của app là chuỗi mờ; chỉ một topic được đánh dấu `General` (topic mặc định, ánh xạ vào General của Chat). Muốn gửi từ Chat thì cài thêm `bridge.Sender` (`SendMessage`, `EditMessage`, `DeleteMessages`) và khai `send`; **chỉ khai khi gửi lại cùng `RandomID` không tạo tin thứ hai** (Telegram bảo đảm, đã đo cho cả tin và album), vì engine gửi lại sau sự cố bằng đúng `RandomID` đã lưu. Lỗi vĩnh viễn trả `ErrNotAllowed`, `ErrEditExpired` hoặc `ErrTooLarge`; lỗi lạ được thử lại.
2. Id ngoài (hội thoại, tin, người) là chuỗi mờ, lõi không phân tích. Dịch lỗi: giới hạn tốc độ thành `*bridge.RateLimitError`, phiên bị thu hồi thành `bridge.ErrSessionRevoked`. Bộ test gửi dùng adapter giả (có dedupe theo `RandomID`) trong `bridge/engine/outbox_test.go`; mẫu kiểm tay gửi thật là [`adapters/telegram/send_live_test.go`](../../server/internal/bridge/adapters/telegram/send_live_test.go) (`BRIDGE_LIVE_SEND=1`, chỉ gửi vào "Tin nhắn đã lưu" và tự xoá).
3. Nối vào map tĩnh ở [`server/internal/api/bridge_adapters.go`](../../server/internal/api/bridge_adapters.go) (không có registry hay plugin loader) và thêm cấu hình cần thiết vào `config`.
4. Kiểm bằng adapter giả [`bridge/contracttest`](../../server/internal/bridge/contracttest/fake.go): nó có log phát lại theo trạng thái như `pts`, và các kịch bản của engine (`bridge/engine/engine_test.go`) là bộ test hợp đồng. Test tự động không chạy trên tài khoản thật; mẫu kiểm tay một lần là [`adapters/telegram/live_test.go`](../../server/internal/bridge/adapters/telegram/live_test.go) (`BRIDGE_LIVE=1`).
5. Thêm tên ứng dụng ở `apps/web/src/messaging/settings/bridge-copy-*.ts` và `chat-row.tsx`.

**Giới hạn của hợp đồng:** ứng dụng kiểu đẩy (webhook: Slack, Messenger) không có kết nối dài nên không có `Subscribe`; chúng vào Chat qua webhook đến ([`hooks`](../../server/internal/hooks)), không qua Bridge. Ứng dụng đăng nhập bằng OAuth chưa có kiểu bước đăng nhập `oauth` (chỉ `input`, `qr`, `confirm`). Zalo là ứng dụng kế tiếp dự kiến, đăng nhập `qr`; Zalo không có API chính thức cho tài khoản cá nhân nên cần phân tích riêng và xem điều khoản trước.
