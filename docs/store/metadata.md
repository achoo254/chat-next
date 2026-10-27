# Chat — hồ sơ App Store (bản nháp)

Bản nháp để dán vào App Store Connect cho app iOS "Chat - trò chuyện" (`apps/mobile`, [mobile-app.md](../mobile-app.md)). Bản đầy đủ cho cả Google Play, căn cứ từng câu trả lời quyền riêng tư và các mục chặn phát hành: [listing.md](./listing.md). File này chỉ gom phần App Store theo cùng khuôn với Scribe. Ngôn ngữ chính của trang App Store: **Tiếng Việt**; thêm bản **English (U.S.)** bằng các dòng tiếng Anh dưới đây. Kiểm với code và trang thật ngày 27/10/2026.

Ký tự đếm bằng số ký tự Unicode (NFC, App Store Connect đếm như vậy); số trong ngoặc là độ dài thật. Riêng từ khoá ghi thêm số byte UTF-8 vì có bản App Store Connect đếm byte.

## Thông tin app

| Trường | Giá trị |
|---|---|
| Bundle ID | `com.hoandat.chat` |
| SKU | `chat-ios` |
| Tên (≤ 30) | `Chat - trò chuyện` (17) — tên của app record đã tạo trên App Store Connect, giữ nguyên cho cả bản EN (tên "Chat" trần gần như chắc chắn đã có người dùng) |
| Phụ đề (≤ 30) | `Nhắn riêng, nhóm, kênh và bot` (29) · EN: `Chats, groups, channels, bots` (29) |
| Danh mục chính / phụ | Social Networking / Productivity |
| URL hỗ trợ | `https://chat.hoandat.com/privacy` (trả 200; trang có mục "Liên hệ" với email người vận hành và cách gửi góp ý trong app. Trang không có neo `#contact`, nên không thêm phần `#…`) |
| URL chính sách quyền riêng tư | `https://chat.hoandat.com/privacy` (trả 200, công khai, không cần đăng nhập) |
| URL marketing (tuỳ chọn) | `https://chat.hoandat.com/` (trả 200) |
| URL điều khoản (EULA tuỳ chỉnh, không bắt buộc) | `https://chat.hoandat.com/terms` — còn mục "đang cập nhật"; để trống thì Apple dùng EULA chuẩn |
| Bản quyền | `2026 hoandat` |
| Giá | Miễn phí, không mua trong app, không quảng cáo |
| Thiết bị | iPhone **và iPad** (`TARGETED_DEVICE_FAMILY = "1,2"` trong `project.pbxproj`) — xem mục Ảnh chụp màn hình |
| iOS tối thiểu | iOS 15.0 (`IPHONEOS_DEPLOYMENT_TARGET = 15.0`) |
| Phiên bản | `1.0` (`MARKETING_VERSION`); bản đầu tiên, không cần "What's New" |
| Mã hoá khi xuất khẩu | `ITSAppUsesNonExemptEncryption = false` đã có trong `Info.plist` (chỉ HTTPS/TLS của hệ điều hành) |

### Văn bản quảng bá (≤ 170)

VI (157): `Chat riêng, nhóm và kênh trong một app. Gửi ảnh, video, tin thoại; tìm lại mọi tin nhắn không cần gõ dấu. Bạn chọn ai nhắn cho mình và ai thêm mình vào nhóm.`

EN (157): `Private chats, groups and channels in one app. Send photos, videos and voice messages, find any message, and choose who can message you or add you to groups.`

### Mô tả

VI (1397):

```
Chat là app nhắn tin cho bạn bè, gia đình và nhóm làm việc, dùng chung một tài khoản trên iPhone, máy tính và trình duyệt.

NHẮN TIN THEO CÁCH BẠN CẦN
• Chat riêng, nhóm, và kênh để đăng tin cho nhiều người theo dõi.
• Gửi ảnh, video, file và tin nhắn thoại; trả lời, sửa, thả cảm xúc, ghim và thu hồi tin.
• Nhóm có chủ đề để tách từng việc; mời người vào bằng link.
• "Cloud của tôi" để lưu ghi chú, link và file cho chính mình.

TÌM LẠI MỌI THỨ
• Tìm chat và tin nhắn không cần gõ dấu: gõ "da lat" vẫn ra "Đà Lạt".
• Kết quả gộp cả tin cũ chưa có trên máy.

TRÊN IPHONE
• Đăng nhập trong trang đăng nhập an toàn của iOS, không nhập mật khẩu vào app.
• Phiên đăng nhập cất trong Keychain, chỉ trên máy này.
• Chụp ảnh, quay video và ghi tin thoại ngay trong chat.
• Gửi link mời nhóm qua bảng chia sẻ của iPhone.

ĐỒNG BỘ MỌI THIẾT BỊ
• Tin nhắn có ngay trên điện thoại, máy tính và web.
• Xem các thiết bị đang đăng nhập và đăng xuất từ xa.

BẠN QUYẾT ĐỊNH QUYỀN RIÊNG TƯ
• Chọn ai thấy trạng thái hoạt động, ai tìm được bạn, ai nhắn tin và ai thêm bạn vào nhóm.
• Chặn và báo cáo tin, người hoặc chat; người kiểm duyệt xem xét mọi báo cáo.
• Xuất dữ liệu của bạn hoặc xoá tài khoản ngay trong app.

BOT
• Trò chuyện với bot Trợ lý, hoặc tự tạo bot của bạn trong Developer Console.

Đăng nhập bằng tài khoản hoandat.com (Google hoặc GitHub). App không có quảng cáo và không bán dữ liệu của bạn.
```

EN (1425):

```
Chat is a messaging app for friends, family and teams, with one account on your iPhone, computer and browser.

MESSAGE THE WAY YOU NEED
• Private chats, groups, and channels for posting to many followers.
• Send photos, videos, files and voice messages; reply, edit, react, pin and unsend.
• Groups with topics keep each subject apart; invite people with a link.
• "My Cloud" keeps notes, links and files for yourself.

FIND ANYTHING
• Search chats and messages, even without Vietnamese accents.
• Results include older messages not yet on your device.

ON IPHONE
• Sign in on the secure iOS sign-in sheet; you never type a password into the app.
• Your session is kept in the Keychain, on this device only.
• Take photos, record videos and voice messages right in a chat.
• Share a group invite link with the iPhone share sheet.

IN SYNC ON EVERY DEVICE
• Your messages are on your phone, computer and the web at once.
• See the devices signed in to your account and sign them out remotely.

YOUR PRIVACY, YOUR CHOICE
• Choose who sees your last seen, who can find you, message you and add you to groups.
• Block and report messages, people or chats; moderators review every report.
• Export your data or delete your account right in the app.

BOTS
• Chat with the Assistant bot, or build your own bots in the Developer Console.

Sign in with your hoandat.com account (Google or GitHub). No ads, and your data is never sold.
```

Căn cứ mục "Trên iPhone": đăng nhập qua `SystemAuth.authenticate` (ASWebAuthenticationSession, `apps/web/src/native/native-sign-in.ts`); token phiên lưu bằng `@aparajita/capacitor-secure-storage` với `KeychainAccess.whenUnlockedThisDeviceOnly` (`apps/web/src/native/session-token.ts`); quyền camera, micro, thư viện ảnh khai trong `Info.plist`; nút chia sẻ link mời dùng `navigator.share` và chỉ hiện khi WebView hỗ trợ (`apps/web/src/messaging/ui/create-dialogs.tsx`). Không viết: thông báo đẩy (chưa có trên app), gọi thoại/video, mã hoá đầu cuối, ảnh đại diện người dùng (chưa có), Mini App trong app.

### Từ khoá (≤ 100, ngăn bằng dấu phẩy, không dấu cách sau dấu phẩy, không lặp tên app)

VI (81 ký tự; 97 byte): `nhắn tin,nhóm,kênh,tin nhắn,bot,gửi ảnh,tin thoại,danh bạ,messenger,ghim,link mời`

EN (94): `messenger,group chat,channels,messaging,bots,voice message,photos,team,contacts,pin,vietnamese`

## Phân loại độ tuổi (Age Rating)

Bảng câu hỏi 2025 của Apple (4+, 9+, 13+, 16+, 18+). Kết quả do Apple tự tính; với chat giữa người dùng và nội dung người dùng tạo, dự kiến **13+** trở lên. Nếu chủ dự án chốt độ tuổi tối thiểu 16 trong Điều khoản (khuyến nghị ở [listing.md](./listing.md#chặn-phát-hành-người-sở-hữu-quyết-định-hoặc-làm-trước-khi-gửi-duyệt)), chọn mức 16+ cho khớp.

| Câu hỏi | Trả lời |
|---|---|
| Bạo lực (hoạt hình, thực tế, kéo dài), nội dung tình dục, khoả thân, ngôn từ thô tục, kinh dị/sợ hãi, rượu, thuốc lá, ma tuý, chủ đề y tế, nội dung người lớn | None (app không có nội dung riêng; nội dung người dùng gửi đi qua báo cáo và kiểm duyệt) |
| Mô phỏng cờ bạc, cờ bạc bằng tiền thật | None / No |
| Cuộc thi | No |
| Trình duyệt web không giới hạn | No (không có trình duyệt trong app; đăng nhập và các app khác của hoandat mở ở trình duyệt hệ thống, `ecosystem-app-switcher.tsx`) |
| Nội dung do người dùng tạo | Yes (tin nhắn, ảnh, video, file, kênh vào bằng link mời) |
| Nhắn tin và chat giữa người dùng | Yes (chat riêng, nhóm, kênh, bot) |
| Mạng xã hội | No (không có bảng tin hay hồ sơ công khai) |
| Quảng cáo | No |
| Kiểm soát của phụ huynh, xác minh tuổi | No |
| Made for Kids | No |

Guideline 1.2 (nội dung người dùng) — có đủ trong code: báo cáo tin (menu tin nhắn, `message-menu.tsx`), báo cáo người/chat (bảng thông tin, `info-panel.tsx`), chặn người (kèm hộp báo cáo; bỏ chặn ở Cài đặt › Người đã chặn), hàng đợi kiểm duyệt phía server (`server/internal/chat/moderation.go`, `moderation_tools.go`: gỡ nội dung, khoá tài khoản chat), email liên hệ công khai trên `/privacy`.

## App Privacy ("nhãn dinh dưỡng")

Khớp [data-inventory.md](../privacy/data-inventory.md) và trang `/privacy` (`apps/web/src/screens/legal/legal-copy.ts`). **Không theo dõi (tracking): No** cho mọi loại (không IDFA, không SDK quảng cáo hay phân tích). Mục đích mọi loại: **App Functionality**.

| Nhóm App Store Connect | Loại | Liên kết với danh tính | Ghi chú |
|---|---|---|---|
| Contact Info | Name | Yes | Tên hiển thị (`users`) |
| Contact Info | Email Address | Yes | Bản sao email đã xác minh từ auth.hoandat.com; người khác tìm bằng email chỉ khi người dùng cho phép (mặc định Không ai) |
| Identifiers | User ID | Yes | Username và mã tài khoản ở IdP (`idp_sub`) |
| User Content | Emails or Text Messages | Yes | Tin nhắn, cảm xúc, ghim, trạng thái đọc |
| User Content | Photos or Videos | Yes | Ảnh, video gửi trong chat |
| User Content | Audio Data | Yes | Tin nhắn thoại |
| User Content | Customer Support | Yes | Góp ý ở Cài đặt › Góp ý (email, số điện thoại trong đó đã che) |
| User Content | Other User Content | Yes | File gửi trong chat, giới thiệu (bio), danh bạ trong app, báo cáo |
| Diagnostics | Other Diagnostic Data | **No** | Lỗi kỹ thuật của app (`client_errors`, đã che email), không gắn tài khoản, giữ 90 ngày |

Không thu thập: Location, Contacts của máy (danh bạ trong app là người dùng Chat bạn tự thêm), Health, Financial, Browsing History, Search History, Sensitive Info, Purchases, Device ID, Usage Data/Analytics. IP, loại thiết bị chung ("iPhone"/"iPad") và phiên bản app của phiên đăng nhập chỉ để chạy dịch vụ và bảo mật (Cài đặt › Phiên đăng nhập).

Lưu ý: `apps/mobile/ios/App/App/` chưa có `PrivacyInfo.xcprivacy` của app (Scribe có). Nếu App Store Connect báo thiếu privacy manifest khi tải build, thêm file đó khớp bảng trên.

## Ghi chú cho App Review

Dán vào **App Review Information → Notes** (tiếng Anh). Email và mật khẩu tài khoản người duyệt chỉ nhập vào ô **Sign-In Information**, không vào đoạn này và không vào repo.

```
Chat is a messaging app (private chats, groups, channels, bots). No in-app purchases, no ads, no tracking.

SIGNING IN
1. Tap "Đăng nhập" (Sign in). The app opens our own account service, auth.hoandat.com, in the
   system browser sheet (ASWebAuthenticationSession); the sign-in page never loads inside the app.
2. Tap "App reviewer sign-in" (the page is in English by default; Vietnamese: "Tài khoản dành cho
   người duyệt ứng dụng").
3. Enter the email and password from the Sign-In Information of this submission. You return to
   the app signed in.
The reviewer account starts empty. To try messaging: tap "+" › "Tạo nhóm" (New group), or open
"Cloud của tôi" (My Cloud) to send yourself messages, photos and voice messages. The "Trợ lý"
(Assistant) bot answers in a chat as well.

NATIVE FEATURES
The session token is stored in the iOS Keychain (this device only) and sent as a bearer token;
sign-in uses the system authentication session; camera, microphone and photo library are used
to send photos, videos and voice messages; group invite links can be shared with the share sheet.

ACCOUNT DELETION (5.1.1(v))
Cài đặt (Settings) › Tài khoản (Account) › "Xoá tài khoản chat" (Delete chat account). It needs
a sign-in within the last 10 minutes; if asked, sign in again with the same reviewer credentials,
then type the username to confirm. The account is locked at once and erased after 30 days; signing
in during that time offers only "cancel deletion". Public instructions:
https://chat.hoandat.com/delete-account

USER-GENERATED CONTENT (1.2)
- Report a message: long-press it › "Báo cáo" (Report). Report a person or chat: open its info ›
  "Báo cáo".
- Block: open a person's info › "Chặn" (Block).
- Reports go to our moderators, who can remove content and lock accounts.
  Contact: the email on https://chat.hoandat.com/privacy

PERMISSIONS
Camera (take photos/videos to send), microphone (voice messages, video sound), photo library
(pick photos/videos to send). Each is requested only when you use that feature.

The interface is in Vietnamese; English labels are given in parentheses above.
```

Trước khi gửi duyệt: bật đăng nhập cho người duyệt ở auth-next (ADR 0010 của auth-next) và tạo tài khoản người duyệt; nút "App reviewer sign-in" đã hiện trên trang đăng nhập thật (kiểm 27/10/2026). Tắt lại sau khi duyệt xong.

Nếu Sign in with Apple được bật ở auth.hoandat.com trước khi gửi (code có sẵn, ADR 0008 của auth-next; ngày 27/10/2026 trang đăng nhập thật **chỉ có Google và GitHub**), thêm vào phần SIGNING IN: "You can also tap Sign in with Apple with any Apple ID; the first sign-in creates a new hoandat.com account." và sửa câu cuối của mô tả thành "(Apple, Google hoặc GitHub)" / "(Apple, Google or GitHub)".

## Ảnh chụp màn hình

Tạo bằng `pnpm store:screenshots` (ảnh web app thật trên stack e2e với tài khoản thử, không có dữ liệu thật; [listing.md](./listing.md#ảnh-và-đồ-hoạ)). PNG không kênh alpha, đo bằng `sips` ngày 27/10/2026:

| Thư mục | Nhóm App Store Connect | Kích thước |
|---|---|---|
| `screenshots/ios-6.9/` | iPhone 6.9" | 1320 × 2868 (cả 5 ảnh) |
| `screenshots/ios-6.5/` | iPhone 6.5" | 1284 × 2778 (cả 5 ảnh) |

Thứ tự tải lên (giống nhau ở hai cỡ):

1. `01-chats.png` — danh sách chat.
2. `02-conversation.png` — chat riêng có ảnh và cảm xúc.
3. `03-group.png` — nhóm có tin ghim.
4. `04-search.png` — tìm kiếm không dấu.
5. `05-privacy.png` — Cài đặt › Quyền riêng tư.

Chưa có ảnh iPad, trong khi app khai iPad (`TARGETED_DEVICE_FAMILY = "1,2"`): App Store Connect sẽ đòi ảnh iPad 13". Hoặc thêm ảnh iPad, hoặc đổi `TARGETED_DEVICE_FAMILY` về `1` (chỉ iPhone) rồi build lại trước khi nộp.
