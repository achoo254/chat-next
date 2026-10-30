# Hồ sơ store của app Chat (App Store, Google Play)

Nội dung để nhập vào App Store Connect và Play Console cho app iOS/Android (`apps/mobile`, bundle/application id `com.hoandat.chat`; [docs/mobile-app.md](../mobile-app.md)). Mọi câu trả lời về dữ liệu dựa trên [data-inventory.md](../privacy/data-inventory.md), trang [`/privacy`](https://chat.hoandat.com/privacy) (`apps/web/src/screens/legal/legal-copy.ts`) và code server; khi chúng đổi, sửa file này. Cập nhật 23/10/2026.

## Chặn phát hành (người sở hữu quyết định hoặc làm trước khi gửi duyệt)

1. **Độ tuổi tối thiểu**: Điều khoản còn ghi "đang cập nhật" ([`/terms`](https://chat.hoandat.com/terms)). Cần chốt trước khi trả lời xếp hạng tuổi và đối tượng mục tiêu của Play. Khuyến nghị **16+**: Nghị định 13/2023 coi người dưới 16 tuổi là trẻ em, xử lý dữ liệu của họ cần phụ huynh đồng ý, mà app không có bước đó.
2. **Tài khoản cho người duyệt**: bật đăng nhập cho người duyệt ở auth-next (ADR 0010 của auth-next, `docs/decisions/0010-review-only-password-sign-in.md`; cách bật ở `docs/deployment-guide.md` của auth-next, mục "Đăng nhập cho người duyệt ứng dụng"), rồi nhập email và mật khẩu vào ô "Sign-in information" của App Store Connect và "App access" của Play Console. Không ghi chúng vào repo. Tắt lại sau khi duyệt xong.
3. **Tên app trên store**: "Chat" gần như chắc chắn đã có người dùng trên App Store. Tên đề xuất ở dưới giữ "Chat" làm tên trên màn hình chính (`CFBundleDisplayName`, `appName` của brand) và thêm phần phân biệt cho tên trên store.
4. **Tên pháp nhân vận hành** còn "đang cập nhật" trên trang quyền riêng tư; tài khoản nhà phát triển (Apple, Google) cần tên người bán khớp.
5. **Mã hoá khi xuất khẩu (Apple)**: app chỉ dùng HTTPS/TLS của hệ điều hành, thuộc diện miễn. `Info.plist` chưa có `ITSAppUsesNonExemptEncryption`; trả lời "None of the algorithms mentioned above" khi upload, hoặc thêm khoá đó (`false`) để khỏi hỏi lại mỗi bản.

## Định vị và danh mục

| | App Store | Google Play |
| --- | --- | --- |
| Danh mục chính | Social Networking | Communication |
| Danh mục phụ | Productivity | (không có) |
| Giá | Miễn phí, không mua trong app | Miễn phí, không mua trong app, không quảng cáo |
| Ngôn ngữ chính | Tiếng Việt (vi) | Tiếng Việt (vi-VN) |

## Nội dung trang store

Giới hạn: tên ≤ 30 ký tự, phụ đề ≤ 30, văn bản quảng bá ≤ 170, từ khoá ≤ 100 (Apple, ngăn bằng dấu phẩy, không dấu cách), mô tả ngắn Play ≤ 80, mô tả ≤ 4000. Độ dài trong ngoặc đã đếm theo ký tự Unicode (NFC). Nếu App Store Connect báo từ khoá tiếng Việt quá dài (một số bản đếm byte), bỏ `ghim tin` rồi `danh bạ`. Không viết điều app không làm: không gọi thoại/video, không mã hoá đầu cuối, chưa có thông báo đẩy trên app.

### Tiếng Việt (vi)

- **Tên (App Store, Play)**: `Chat hoandat: Nhắn tin nhóm` (27)
- **Phụ đề (App Store)**: `Nhóm, kênh và bot, mọi máy` (26)
- **Mô tả ngắn (Play)**: `Nhắn tin riêng, nhóm, kênh và bot; tìm tin không cần gõ dấu, đồng bộ mọi máy.` (77)
- **Văn bản quảng bá (App Store)**: `Chat riêng, nhóm và kênh trong một app. Gửi ảnh, video, tin thoại; tìm lại mọi tin nhắn không cần gõ dấu. Bạn chọn ai thấy mình, ai nhắn và ai thêm bạn vào nhóm.` (161)
- **Từ khoá (App Store)**: `nhắn tin,chat nhóm,kênh,tin nhắn,bot,trò chuyện,gửi ảnh,tin thoại,nhóm làm việc,danh bạ,ghim tin` (96; 117 byte UTF-8)
- **Mô tả**:

```text
Chat là app nhắn tin cho bạn bè, gia đình và nhóm làm việc, dùng chung một tài khoản trên điện thoại, máy tính và trình duyệt.

NHẮN TIN THEO CÁCH BẠN CẦN
• Chat riêng, nhóm, và kênh để đăng tin cho nhiều người theo dõi.
• Gửi ảnh, video, file và tin nhắn thoại; trả lời, sửa, thả cảm xúc, ghim và thu hồi tin.
• Nhóm có chủ đề để tách từng việc; mời người vào bằng link.
• "Cloud của tôi" để lưu ghi chú, link và file cho chính mình.

TÌM LẠI MỌI THỨ
• Tìm chat và tin nhắn không cần gõ dấu: gõ "da lat" vẫn ra "Đà Lạt".
• Lọc theo người gửi, loại tin và ngày; kết quả gộp cả tin cũ chưa có trên máy.

ĐỒNG BỘ MỌI THIẾT BỊ
• Tin nhắn có ngay trên điện thoại, máy tính và web.
• Xem các thiết bị đang đăng nhập và đăng xuất từ xa.

BẠN QUYẾT ĐỊNH QUYỀN RIÊNG TƯ
• Chọn ai thấy trạng thái hoạt động và ảnh đại diện, ai tìm được bạn, ai nhắn tin và ai thêm bạn vào nhóm.
• Chặn và báo cáo tin, người hoặc chat.
• Xuất dữ liệu của bạn hoặc xoá tài khoản ngay trong app.

BOT VÀ TÍCH HỢP
• Dùng bot do cộng đồng tạo, hoặc tự tạo bot của bạn trong Developer Console.

Đăng nhập bằng tài khoản hoandat.com (Google, GitHub hoặc Apple). App không có quảng cáo và không bán dữ liệu của bạn.
```

### English (en)

- **Name**: `Chat hoandat: Group Messaging` (29)
- **Subtitle**: `Groups, channels and bots` (25)
- **Short description (Play)**: `Private chats, groups, channels and bots, synced across all your devices.` (73)
- **Promotional text**: `Private chats, groups and channels in one app. Send photos, videos and voice messages, find any message, and choose who can see you, message you or add you to groups.` (166)
- **Keywords**: `messenger,group chat,channels,messaging,bots,chat app,voice message,photos,team chat,contacts,pin` (97)
- **Description**:

```text
Chat is a messaging app for friends, family and teams, with one account on your phone, computer and browser.

MESSAGE THE WAY YOU NEED
• Private chats, groups, and channels for posting to many followers.
• Send photos, videos, files and voice messages; reply, edit, react, pin and unsend.
• Groups with topics keep each subject apart; invite people with a link.
• "My Cloud" keeps notes, links and files for yourself.

FIND ANYTHING
• Search chats and messages, even without Vietnamese accents.
• Filter by sender, type and date; results include older messages not yet on your device.

IN SYNC ON EVERY DEVICE
• Your messages are on your phone, computer and the web at once.
• See the devices signed in to your account and sign them out remotely.

YOUR PRIVACY, YOUR CHOICE
• Choose who sees your last seen and photo, who can find you, message you and add you to groups.
• Block and report messages, people or chats.
• Export your data or delete your account right in the app.

BOTS AND INTEGRATIONS
• Use bots made by the community, or build your own in the Developer Console.

Sign in with your hoandat.com account (Google, GitHub or Apple). No ads, and your data is never sold.
```

## Ảnh và đồ hoạ

| Ô | File | Kích thước | Sinh bằng |
| --- | --- | --- | --- |
| App Store iPhone 6.9" | `screenshots/ios-6.9/01…05-*.png` | 1320 × 2868 | `pnpm store:screenshots` |
| App Store iPhone 6.5" | `screenshots/ios-6.5/01…05-*.png` | 1284 × 2778 | `pnpm store:screenshots` |
| Play ảnh điện thoại | `screenshots/android/01…05-*.png` | 1080 × 1920 (9:16) | `pnpm store:screenshots` |
| Play feature graphic | `play/feature-graphic.png` | 1024 × 500, không alpha | `pnpm brand:gen` |
| Play icon độ phân giải cao | `brand/generated/icons/icon-maskable-512.png` | 512 × 512 | `pnpm brand:gen` |
| Icon App Store | trong app (`AppIcon.appiconset`, 1024, không alpha) | | `pnpm brand:gen` |

Năm màn, đúng thứ tự: danh sách chat (01), chat riêng có ảnh và cảm xúc (02), nhóm có tin ghim (03), tìm kiếm không dấu (04), Cài đặt › Quyền riêng tư (05). Ảnh chụp web app thật trên stack e2e ([`apps/web/test/e2e/store-screenshots.ts`](../../apps/web/test/e2e/store-screenshots.ts)): database mới, IdP giả, tài khoản thử An, Bình, Chi, Giang, ảnh phong cảnh vẽ trong trình duyệt; không có dữ liệu thật. Chụp lại khi giao diện đổi: `pnpm store:screenshots` (dựng stack như `pnpm e2e`, cổng 4600/4610/4630/5173 phải trống, một trình duyệt, xoá và ghi lại `docs/store/screenshots/`).

## URL

| Ô | URL | Ghi chú |
| --- | --- | --- |
| Privacy Policy (Apple, Play) | `https://chat.hoandat.com/privacy` | Trang công khai, không cần đăng nhập (`paths.privacy`, `matchLegal` trong `apps/web/src/router.tsx`). |
| Support URL (Apple, bắt buộc) | `https://chat.hoandat.com/privacy` | Tạm thời: trang có mục "Liên hệ" với email và cách gửi góp ý trong app. Nên có trang hỗ trợ riêng. |
| Marketing URL (tuỳ chọn) | `https://chat.hoandat.com/` | Trang chào cho người chưa đăng nhập. |
| Điều khoản (EULA tuỳ chỉnh, tuỳ chọn) | `https://chat.hoandat.com/terms` | Còn mục "đang cập nhật"; để trống thì Apple dùng EULA chuẩn. |
| Xoá tài khoản (Play, bắt buộc) | `https://chat.hoandat.com/delete-account` | Trang riêng nêu các bước xoá, điều gì xảy ra, dữ liệu còn lại và cách xin xoá qua email khi không đăng nhập được. |

## Câu trả lời xếp hạng tuổi

### Apple (bảng hỏi 2025: 4+, 9+, 13+, 16+, 18+)

| Mục | Trả lời | Căn cứ |
| --- | --- | --- |
| Parental Controls | Không | |
| Age Assurance | Không | App không hỏi tuổi. |
| Unrestricted Web Access | Không | Không có trình duyệt trong app; đăng nhập mở trình duyệt hệ thống, Mini App trong app native chưa có ([mobile-app.md](../mobile-app.md#chưa-làm)). |
| User-Generated Content | Có | Tin nhắn, ảnh, video, file, kênh công khai qua link mời. |
| Messaging and Chat | Có | Chat riêng, nhóm, kênh, bot. |
| Social Media | Không | Không có bảng tin hay hồ sơ công khai; kênh chỉ vào được bằng link mời. |
| Advertising | Không | |
| Bạo lực, kinh dị, ngôn từ, tình dục, rượu/ma tuý, y tế, cờ bạc, cuộc thi | None | App không có nội dung riêng; nội dung do người dùng gửi đi qua báo cáo và kiểm duyệt. |

Mức cuối do Apple tính từ các câu trên và độ tuổi người sở hữu chốt (chặn phát hành mục 1); app có chat và nội dung người dùng nên khả năng **13+** hoặc cao hơn. Kids Category: **không**.

App có nội dung người dùng tạo nên phải đáp ứng Guideline 1.2: báo cáo tin/người/chat (có), chặn người (có), người kiểm duyệt xử lý báo cáo (có, hàng đợi kiểm duyệt), thông tin liên hệ công khai (email trên `/privacy`).

### Google Play (IARC)

- Loại app: Mạng xã hội, nhắn tin, giao tiếp. Bạo lực, sợ hãi, tình dục, ngôn từ, ma tuý, cờ bạc: không có nội dung riêng.
- Người dùng tương tác hoặc trao đổi nội dung: **Có**. Chia sẻ vị trí thật của người dùng với người khác: **Không**. Mua hàng số: **Không**. Truy cập internet không giới hạn: **Không**.
- Kết quả dự kiến: mức thấp kèm ghi chú "Users Interact" (IARC tự tính; ghi lại kết quả thật sau khi nộp).

### Google Play: Đối tượng mục tiêu

Theo độ tuổi người sở hữu chốt (khuyến nghị 16 trở lên). Không chọn nhóm dưới 13: app không làm theo chính sách Families. "Có thể vô tình thu hút trẻ em": Không (giao diện và nội dung không hướng tới trẻ em).

## Apple App Privacy (nhãn quyền riêng tư)

Tracking: **Không** (không IDFA, không SDK quảng cáo hay phân tích, không chia sẻ dữ liệu với bên thứ ba để quảng cáo hay cho data broker).

| Loại dữ liệu | Mục đích | Liên kết với danh tính | Căn cứ |
| --- | --- | --- | --- |
| Contact Info → Name | App Functionality | Có | Tên hiển thị (`users`). |
| Contact Info → Email Address | App Functionality | Có | Bản sao email đã xác minh từ auth.hoandat.com, đọc lại mỗi lần đăng nhập; người khác tìm bằng email chỉ khi người dùng cho phép (mặc định Không ai). |
| Identifiers → User ID | App Functionality | Có | Username và mã tài khoản ở nơi đăng nhập (`idp_sub`). |
| User Content → Emails or Text Messages | App Functionality | Có | Tin nhắn, cảm xúc, ghim, trạng thái đọc. |
| User Content → Photos or Videos | App Functionality | Có | Ảnh, video gửi trong chat. |
| User Content → Audio Data | App Functionality | Có | Tin nhắn thoại. |
| User Content → Customer Support | App Functionality | Có | Góp ý ở Cài đặt › Góp ý (email, số điện thoại trong đó đã che). |
| User Content → Other User Content | App Functionality | Có | File gửi trong chat, giới thiệu (bio), danh bạ trong app, báo cáo gửi về tin/người/chat. |
| Diagnostics → Other Diagnostic Data | App Functionality | Không | Lỗi kỹ thuật của app (thông điệp đã che email, màn hình, bản build), không gắn tài khoản, giữ 90 ngày (`client_errors`). |

Không thu: vị trí, danh bạ của máy (danh bạ của app là người dùng Chat bạn tự thêm, app không đọc danh bạ điện thoại), lịch sử duyệt web, dữ liệu sức khoẻ, tài chính, mua hàng, mã thiết bị, dữ liệu sử dụng/phân tích. Địa chỉ IP, loại thiết bị chung ("iPhone", "Android") và phiên bản app của phiên đăng nhập dùng để chạy dịch vụ và bảo mật (Cài đặt › Phiên đăng nhập), không dùng để suy vị trí. Từ khoá gõ khi gọi bot (@bot) giữ 1 ngày cho bot trả lời; những gì người dùng gửi bot đi tới máy chủ của người tạo bot do chính người dùng chủ động gửi (trang quyền riêng tư, mục "Bot và Mini App").

## Google Play Data safety

- Thu thập: **Có**. Chia sẻ với bên thứ ba: **Không** (Cloudflare là nhà cung cấp xử lý thay nhà vận hành; tin gửi bot là người dùng chủ động gửi tới bot họ chọn, theo định nghĩa của Play không tính là chia sẻ). Mã hoá khi truyền: **Có** (HTTPS, WSS). Người dùng yêu cầu xoá được: **Có** (trong app: Cài đặt › Tài khoản › Xoá tài khoản chat; trên web: `https://chat.hoandat.com/delete-account`).
- Cách tạo tài khoản: đăng nhập OAuth/OpenID Connect qua auth.hoandat.com (Google, GitHub, Apple).

| Nhóm Play | Loại | Bắt buộc/tuỳ chọn | Mục đích |
| --- | --- | --- | --- |
| Personal info | Name | Bắt buộc | App functionality, Account management |
| Personal info | Email address | Bắt buộc | App functionality, Account management |
| Personal info | User IDs | Bắt buộc | App functionality, Account management |
| Messages | Other in-app messages | Bắt buộc | App functionality |
| Photos and videos | Photos, Videos | Tuỳ chọn | App functionality |
| Audio | Voice or sound recordings | Tuỳ chọn | App functionality |
| Files and docs | Files and docs | Tuỳ chọn | App functionality |
| App activity | Other user-generated content | Tuỳ chọn | App functionality (bio, danh bạ trong app, góp ý, báo cáo) |
| App info and performance | Crash logs / Diagnostics | Bắt buộc | Analytics (Play xếp "chẩn đoán và sửa lỗi" vào Analytics); không gắn tài khoản |

Mọi loại trên đều không "ephemeral" (được lưu trên server). Không thu: vị trí, danh bạ máy, lịch, sức khoẻ, tài chính, lịch sử web, ứng dụng đã cài, mã thiết bị hay quảng cáo.

## Ghi chú cho người duyệt (App Review Notes, tiếng Anh)

Dán vào "Notes" của App Review (Apple) và phần hướng dẫn của "App access" (Play). Email và mật khẩu đi vào ô đăng nhập riêng của từng store, không vào đoạn này.

```text
Chat is a messaging app (private chats, groups, channels, bots). It has no in-app purchases, no ads and no tracking.

SIGNING IN
1. Tap "Đăng nhập" (Sign in). The app opens our sign-in page, auth.hoandat.com, in the system browser sheet (ASWebAuthenticationSession on iOS, Custom Tab on Android).
2. Under the provider buttons, tap "Tài khoản dành cho người duyệt ứng dụng" (App reviewer sign-in).
3. Enter the email and password from the sign-in information of this submission. You return to the app signed in.
The reviewer account starts empty. To try messaging: tap "+" › "Tạo nhóm" (New group) to create a group, or open "Cloud của tôi" (My Cloud) to send yourself messages, photos and voice messages. The "Trợ lý" (Assistant) bot answers in a chat as well.

ACCOUNT DELETION (Guideline 5.1.1(v))
Cài đặt (Settings) › Tài khoản (Account) › "Xoá tài khoản chat" (Delete chat account). Deleting needs a sign-in within the last 10 minutes; if asked, sign in again with the same reviewer credentials, then type the username to confirm. The account is deleted after a 30-day grace period during which signing in offers only "cancel deletion". Public instructions: https://chat.hoandat.com/delete-account

USER-GENERATED CONTENT (Guideline 1.2)
• Report: long-press a message › "Báo cáo" (Report); a person or chat: open its info › "Báo cáo".
• Block: open a person's info › "Chặn" (Block).
• Reports are reviewed by our moderators, who can remove content, ban people from groups, and lock accounts. Contact: the email on https://chat.hoandat.com/privacy

PERMISSIONS
Camera (take photos/videos to send), microphone (voice messages, video sound), photo library (pick photos/videos to send). Each is requested only when you use that feature.

The interface is in Vietnamese; English labels are given in parentheses above.
```
