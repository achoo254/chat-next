// Text of the public pages: privacy policy, terms of use and account
// deletion. Every statement restates a fact of this repository (schema,
// code, infra docs); docs/privacy/legal-pages-draft.md lists each claim with
// its source, and is where the owner's review is tracked. Change a fact
// there and here together.
import { brand } from "../../brand.ts";
import { DELETION_GRACE_DAYS, deletionTicks } from "../../i18n/account-deletion.ts";
import type { Locale } from "../../i18n/i18n.tsx";
import { pushServicesNote } from "../../i18n/push-services.ts";
import { paths, type LegalPage } from "../../router.tsx";

/** A link at the end of a section. */
export interface LegalLink {
	readonly href: string;
	readonly label: string;
	/** page (default): another public page; site: another site (the IdP), in a new tab; email: a mailto: link. */
	readonly kind?: "page" | "site" | "email";
}

export interface LegalSection {
	readonly title: string;
	readonly paragraphs?: readonly string[];
	readonly items?: readonly string[];
	/** Numbered steps (an ordered list). */
	readonly steps?: readonly string[];
	readonly link?: LegalLink;
	/** Not decided yet: shown marked as "Đang cập nhật". */
	readonly pending?: boolean;
}

export interface LegalDocument {
	readonly title: string;
	readonly lede: string;
	readonly sections: readonly LegalSection[];
}

export interface LegalCopy {
	readonly updated: string;
	readonly documents: Readonly<Record<LegalPage, LegalDocument>>;
}

/** When the text last changed (shown on every page). */
export const LEGAL_UPDATED = { vi: "26/10/2026", en: "26 October 2026", "zh-CN": "2026年10月26日" } as const;

const { appName, domain, webHost, idpHost, accountUrl } = brand;

/**
 * The operator's contact for privacy, terms and deletion requests. Its
 * servers are in Vietnam and the web host goes through Cloudflare.
 */
const OPERATOR_EMAIL = "quocdat254@gmail.com";
const mailto = (email: string): LegalLink => ({ href: `mailto:${email}`, label: email, kind: "email" });

const vi: LegalCopy = {
	updated: `Cập nhật ${LEGAL_UPDATED.vi}`,
	documents: {
		privacy: {
			title: "Chính sách quyền riêng tư",
			lede: `Dữ liệu ${appName} (${webHost}) giữ khi bạn dùng app, giữ ở đâu, bao lâu, và cách bạn xuất hoặc xoá dữ liệu đó.`,
			sections: [
				{
					title: "Đăng nhập",
					paragraphs: [
						`Bạn đăng nhập bằng tài khoản ${domain} ở ${idpHost}, bằng Google, GitHub hoặc Apple. App chat không bao giờ thấy mật khẩu của bạn.`,
						`Danh tính Google, GitHub hoặc Apple, email gốc và cách đăng nhập do ${idpHost} giữ, không phải app chat. Bạn quản lý hoặc xoá tài khoản ${domain} ở ${idpHost}/account.`,
					],
				},
				{
					title: "Dữ liệu app chat giữ",
					items: [
						"Hồ sơ: username, tên hiển thị, giới thiệu và mã tài khoản ở nơi đăng nhập.",
						`Email: bản sao email đã xác minh của tài khoản ${domain}, đọc lại mỗi lần đăng nhập. Người khác chỉ tìm được bạn bằng email khi bạn cho phép (mặc định: Không ai).`,
						`Ảnh tài khoản: đường dẫn ảnh Google hoặc GitHub của tài khoản ${domain}, đọc lại mỗi lần đăng nhập (đăng nhập bằng Apple thì không có ảnh, vì Apple không chia sẻ ảnh). Chỉ bạn thấy, trên nút tài khoản, khi bạn chưa tải ảnh đại diện lên app chat.`,
						"Phiên đăng nhập: địa chỉ IP, trình duyệt hoặc thiết bị và thời điểm dùng.",
						"Tin nhắn, cảm xúc, tin ghim, trạng thái đã đọc và file bạn gửi (ảnh, video, file, tin thoại).",
						"Danh bạ, người bạn đã chặn, và cài đặt quyền riêng tư, thông báo, tự xoá.",
						"Đăng ký nhận thông báo đẩy của trình duyệt, khi bạn bật.",
						"Góp ý bạn gửi, với email và số điện thoại trong đó đã được che.",
						"Báo cáo bạn gửi về một tin, một người hoặc một chat.",
						"Lỗi kỹ thuật của trình duyệt (đã che email), để sửa lỗi; không gắn với tài khoản của bạn.",
					],
				},
				{
					title: "Dùng dữ liệu để làm gì",
					paragraphs: [
						"Để chạy dịch vụ bạn đăng ký dùng: gửi và đồng bộ tin giữa các thiết bị, tìm kiếm, thông báo.",
						"Một số việc chỉ khi bạn tự bật: thông báo đẩy, cho người khác tìm bạn bằng email.",
						"Để giữ an toàn và chống lạm dụng: phiên đăng nhập, báo cáo, nhật ký kiểm duyệt, bản sao lưu và log.",
					],
				},
				{
					title: "Lưu ở đâu",
					items: [
						"Cơ sở dữ liệu, file và bản sao lưu nằm trên máy chủ của nhà vận hành; hiện chưa có bản lưu trữ hay sao lưu nào ở ngoài máy chủ đó.",
						"Máy chủ đặt tại Việt Nam.",
						`Kết nối tới ${webHost} đi qua Cloudflare.`,
						`Trang web ${webHost} dùng Cloudflare Web Analytics để đếm lượt xem trang; công cụ này không đặt cookie và không lưu gì trên thiết bị của bạn.`,
						"Log của app chỉ ghi mã định danh; không ghi nội dung tin, email hay token.",
					],
				},
				{
					title: "Giữ bao lâu",
					items: [
						"Hồ sơ, danh bạ, cài đặt và góp ý: tới khi bạn xoá tài khoản chat.",
						"Tin nhắn: tới khi tin bị thu hồi hoặc chat bị xoá.",
						"File: tới khi không còn tin nào dùng, rồi thêm 1 ngày.",
						"Phiên đăng nhập trên web: hết hạn sau 30 ngày không dùng, dài nhất 90 ngày.",
						"Chi tiết ai đã đọc tin: 7 ngày. Log đồng bộ giữa thiết bị: 30 ngày.",
						"Lỗi kỹ thuật của trình duyệt: 90 ngày.",
						"Từ khoá bạn gõ khi gọi bot (@bot): 1 ngày. Lượt gửi hàng loạt của bot: 30 ngày sau khi xong.",
						"Bản xuất dữ liệu: 30 ngày.",
						"Bản sao lưu: 14 bản hằng ngày, nên dữ liệu đã xoá còn trong bản sao lưu tối đa 14 ngày.",
						"Báo cáo và nhật ký kiểm duyệt: giữ cả sau khi tài khoản bị xoá, để xử lý khiếu nại.",
					],
				},
				{
					title: "Thông báo đẩy",
					paragraphs: [
						pushServicesNote.vi,
						"Bạn tắt xem trước nội dung trong thông báo ở Cài đặt › Thông báo.",
					],
				},
				{
					title: "Bot và Mini App",
					items: [
						"Bot do người dùng tạo và chạy trên máy chủ của người tạo bot. Những gì bạn gửi cho bot (tin, lệnh, nút bấm, từ khoá khi gọi @bot) được chuyển tới máy chủ đó.",
						"Cài đặt quyền riêng tư áp dụng cho cả bot: bot không thấy được những gì bạn đã ẩn.",
						"Bot chỉ gửi tin hàng loạt cho người đã bắt đầu bot đó.",
						"Mini App là trang web của người tạo bot, mở trong app; app hiện tên miền của trang. Trang đó thấy những gì bạn làm trong nó.",
					],
				},
				{
					title: "Trên thiết bị của bạn",
					paragraphs: [
						"Trình duyệt giữ một bản sao chat để mở nhanh và dùng khi không có mạng. Bản sao này không mã hoá, tách riêng theo từng tài khoản và bị xoá khi bạn đăng xuất.",
					],
				},
				{
					title: "Quyền của bạn",
					items: [
						"Chọn ai thấy trạng thái hoạt động và ảnh đại diện, ai tìm được bạn, ai thêm bạn vào nhóm và ai nhắn tin cho bạn: Cài đặt › Quyền riêng tư.",
						"Xem và đăng xuất các thiết bị: Cài đặt › Phiên đăng nhập.",
						"Xuất dữ liệu: Cài đặt › Tài khoản. Bản xuất chạy nền, tải trong app, mỗi 7 ngày một lần và giữ 30 ngày. Gồm hồ sơ, danh bạ, người đã chặn, phiên, bot (không có token), danh sách chat, tin bạn gửi và file bạn gửi; không có tin của người khác.",
						"Tự xoá tài khoản chat khi không dùng 6, 12 hoặc 24 tháng (mặc định tắt): Cài đặt › Tài khoản.",
						"Xoá tài khoản chat bất cứ lúc nào.",
					],
					link: { href: paths.deleteAccount, label: "Cách xoá tài khoản" },
				},
				{
					title: "Liên hệ",
					paragraphs: [
						`Gửi câu hỏi hoặc yêu cầu về dữ liệu cá nhân (xem, xuất, sửa, xoá) tới ${OPERATOR_EMAIL}.`,
						"Trong app, bạn cũng gửi được ở Cài đặt › Góp ý; câu trả lời đến qua bot Trợ lý.",
					],
					link: mailto(OPERATOR_EMAIL),
				},
				{
					title: "Đang cập nhật",
					pending: true,
					paragraphs: ["Tên pháp nhân vận hành dịch vụ đang được cập nhật."],
				},
			],
		},
		terms: {
			title: "Điều khoản sử dụng",
			lede: `Các quy tắc ${appName} (${webHost}) áp dụng khi bạn dùng dịch vụ.`,
			sections: [
				{
					title: "Tài khoản",
					paragraphs: [
						`Bạn dùng app bằng tài khoản ${domain}. Tài khoản chat là của riêng app này: xoá nó không xoá tài khoản ${domain}.`,
					],
				},
				{
					title: "Báo cáo nội dung",
					paragraphs: [
						`Bạn báo cáo được một tin, một người hoặc một chat vì spam, lừa đảo, bạo lực, nội dung khiêu dâm hoặc lý do khác. Người kiểm duyệt của ${domain} xem xét từng báo cáo.`,
					],
				},
				{
					title: "Biện pháp kiểm duyệt",
					paragraphs: ["Khi xử lý báo cáo, người kiểm duyệt có thể:"],
					items: [
						"Gỡ nội dung.",
						"Xoá và cấm một người khỏi nhóm hoặc kênh.",
						"Cảnh cáo, hoặc khoá tài khoản chat.",
						"Giới hạn việc bắt đầu chat với người chưa quen.",
						"Với bot: hạ xuống tầng Hạn chế hoặc tắt webhook.",
					],
				},
				{
					title: "Chống spam",
					paragraphs: [
						"Tài khoản mới nhắn cho người lạ bị giới hạn số tin. Bot vi phạm luật chống lạm dụng tự bị hạ xuống tầng Hạn chế.",
					],
				},
				{
					title: "Nhóm và kênh",
					paragraphs: ["Muốn xoá tài khoản chat khi còn là chủ sở hữu nhóm hoặc kênh, bạn chuyển quyền sở hữu hoặc xoá chúng trước."],
				},
				{
					title: "Bot",
					paragraphs: [
						"Bạn tạo bot ở Cài đặt › Developer Console. Token của bot chỉ hiện một lần; máy chủ chỉ giữ bản băm. Bot của bạn ngừng chạy ngay khi bạn bắt đầu xoá tài khoản và bị xoá cùng tài khoản.",
					],
				},
				{
					title: "Ngừng dùng",
					paragraphs: ["Bạn xoá tài khoản chat bất cứ lúc nào trong app."],
					link: { href: paths.deleteAccount, label: "Cách xoá tài khoản" },
				},
				{
					title: "Quyền riêng tư",
					paragraphs: ["Dữ liệu app giữ và thời hạn lưu nằm ở Chính sách quyền riêng tư."],
					link: { href: paths.privacy, label: "Chính sách quyền riêng tư" },
				},
				{ title: "Liên hệ", paragraphs: [`Câu hỏi về các điều khoản này: ${OPERATOR_EMAIL}.`], link: mailto(OPERATOR_EMAIL) },
				{
					title: "Đang cập nhật",
					pending: true,
					paragraphs: ["Các nội dung sau đang được cập nhật: tên pháp nhân vận hành dịch vụ, độ tuổi tối thiểu, giới hạn trách nhiệm, luật áp dụng và cách giải quyết tranh chấp."],
				},
			],
		},
		"delete-account": {
			title: "Xoá tài khoản",
			lede: `Cách xoá tài khoản chat của ${appName} và dữ liệu đi kèm.`,
			sections: [
				{
					title: "Cách xoá",
					steps: [
						`Đăng nhập ở ${webHost}.`,
						"Mở Cài đặt › Tài khoản, đến mục Xoá tài khoản chat.",
						`Nếu được hỏi, đăng nhập lại ở ${idpHost} (cần một lần đăng nhập trong 10 phút gần nhất).`,
						"Gõ username của bạn để xác nhận, rồi bấm Xoá tài khoản.",
					],
					paragraphs: ["Nếu bạn là chủ sở hữu nhóm hoặc kênh, chuyển quyền sở hữu hoặc xoá chúng trước."],
				},
				{
					title: "Điều gì xảy ra",
					items: [
						...deletionTicks.vi(DELETION_GRACE_DAYS, idpHost),
						"Mọi thiết bị đăng xuất. Bot của bạn ngừng chạy ngay và bị xoá cùng tài khoản.",
					],
				},
				{
					title: "Huỷ xoá",
					paragraphs: [`Đăng nhập lại trong ${DELETION_GRACE_DAYS} ngày, app chỉ hiện một lựa chọn: Huỷ xoá tài khoản.`],
				},
				{
					title: "Dữ liệu còn lại sau khi xoá",
					items: [
						"Dữ liệu đã xoá còn trong bản sao lưu tối đa 14 ngày.",
						"Báo cáo bạn đã gửi và nhật ký kiểm duyệt được giữ để xử lý khiếu nại; người báo cáo hiện là tài khoản đã xoá.",
					],
				},
				{
					title: `Tài khoản ${domain}`,
					paragraphs: [`Xoá tài khoản chat không xoá tài khoản ${domain}. Muốn xoá tài khoản đó, vào trang tài khoản ở ${idpHost}.`],
					link: { href: accountUrl, label: `Tài khoản ${domain}`, kind: "site" },
				},
				{
					title: "Không đăng nhập được?",
					paragraphs: [`Gửi yêu cầu xoá tài khoản chat tới ${OPERATOR_EMAIL}, ghi rõ username của bạn và email của tài khoản ${domain}.`],
					link: mailto(OPERATOR_EMAIL),
				},
			],
		},
	},
};

const en: LegalCopy = {
	updated: `Updated ${LEGAL_UPDATED.en}`,
	documents: {
		privacy: {
			title: "Privacy policy",
			lede: `The data ${appName} (${webHost}) keeps when you use it, where, for how long, and how you export or delete it.`,
			sections: [
				{
					title: "Signing in",
					paragraphs: [
						`You sign in with your ${domain} account at ${idpHost}, using Google, GitHub or Apple. The chat app never sees your password.`,
						`Your Google, GitHub or Apple identity, original email and sign-in methods are kept by ${idpHost}, not by the chat app. Manage or delete your ${domain} account at ${idpHost}/account.`,
					],
				},
				{
					title: "What the chat app keeps",
					items: [
						"Profile: username, display name, bio and the id of your sign-in account.",
						`Email: a copy of your ${domain} account's verified email, read again at every sign-in. Others find you by email only if you allow it (default: Nobody).`,
						`Account picture: the link to the Google or GitHub picture of your ${domain} account, read again at every sign-in (signing in with Apple gives no picture, because Apple does not share one). Only you see it, on the account button, while you have not uploaded a profile photo to the chat app.`,
						"Sessions: IP address, browser or device, and when they were used.",
						"Messages, reactions, pins, read state and the files you send (photos, videos, files, voice messages).",
						"Contacts, people you blocked, and your privacy, notification and auto-delete settings.",
						"Your browser's push subscription, when you turn notifications on.",
						"Feedback you send, with emails and phone numbers in it masked.",
						"Reports you send about a message, a person or a chat.",
						"Technical errors in the browser (emails masked), to fix bugs; not tied to your account.",
					],
				},
				{
					title: "What it is used for",
					paragraphs: [
						"Running the service you signed up for: delivering and syncing messages across devices, search, notifications.",
						"Some only when you turn them on: push notifications, letting others find you by email.",
						"Safety and abuse prevention: sessions, reports, the moderation log, backups and logs.",
					],
				},
				{
					title: "Where it is stored",
					items: [
						"The database, files and backups are on the operator's server; no storage or backup outside that server yet.",
						"The servers are in Vietnam.",
						`Connections to ${webHost} go through Cloudflare.`,
						`The ${webHost} website counts page views with Cloudflare Web Analytics, which sets no cookies and stores nothing on your device.`,
						"The app's logs record ids only, never message text, emails or tokens.",
					],
				},
				{
					title: "How long it is kept",
					items: [
						"Profile, contacts, settings and feedback: until you delete your chat account.",
						"Messages: until they are unsent or the chat is deleted.",
						"Files: until no message uses them, plus 1 day.",
						"Web sessions: end after 30 days unused, 90 days at most.",
						"Who read each message: 7 days. Sync logs between devices: 30 days.",
						"Browser errors: 90 days.",
						"What you type when calling a bot (@bot): 1 day. A bot's bulk sends: 30 days after they finish.",
						"Data exports: 30 days.",
						"Backups: 14 daily copies, so deleted data stays in backups for up to 14 days.",
						"Reports and the moderation log: kept after an account is deleted, to handle appeals.",
					],
				},
				{
					title: "Push notifications",
					paragraphs: [
						pushServicesNote.en,
						"Turn off message previews in notifications in Settings › Notifications.",
					],
				},
				{
					title: "Bots and Mini Apps",
					items: [
						"Bots are made by users and run on their makers' servers. What you send a bot (messages, commands, button presses, what you type after @bot) goes to that server.",
						"Privacy settings apply to bots too: a bot cannot see what you have hidden.",
						"A bot sends bulk messages only to people who started it.",
						"A Mini App is the bot maker's website, opened in the app with its domain shown. That site sees what you do in it.",
					],
				},
				{
					title: "On your device",
					paragraphs: [
						"Your browser keeps a copy of your chats to open quickly and work offline. The copy is not encrypted, is kept apart for each account, and is deleted when you sign out.",
					],
				},
				{
					title: "Your rights",
					items: [
						"Choose who sees your last seen and photo, who can find you, add you to groups and message you: Settings › Privacy.",
						"See and sign out your devices: Settings › Sessions.",
						"Export your data: Settings › Account. The export runs in the background, downloads in the app, once every 7 days, and is kept 30 days. It has your profile, contacts, blocked people, sessions, bots (no tokens), chat list, the messages and files you sent; no one else's messages.",
						"Delete your chat account automatically after 6, 12 or 24 months unused (off by default): Settings › Account.",
						"Delete your chat account at any time.",
					],
					link: { href: paths.deleteAccount, label: "How to delete your account" },
				},
				{
					title: "Contact",
					paragraphs: [
						`Send questions or requests about your personal data (access, export, correction, deletion) to ${OPERATOR_EMAIL}.`,
						"In the app you can also use Settings › Feedback; replies come through the Assistant bot.",
					],
					link: mailto(OPERATOR_EMAIL),
				},
				{
					title: "Being updated",
					pending: true,
					paragraphs: ["The name of the legal entity operating the service is being added."],
				},
			],
		},
		terms: {
			title: "Terms of use",
			lede: `The rules ${appName} (${webHost}) applies when you use the service.`,
			sections: [
				{
					title: "Your account",
					paragraphs: [`You use the app with your ${domain} account. The chat account belongs to this app only: deleting it does not delete your ${domain} account.`],
				},
				{
					title: "Reporting content",
					paragraphs: [
						`You can report a message, a person or a chat for spam, scams, violence, sexual content or another reason. The moderators of ${domain} review every report.`,
					],
				},
				{
					title: "Moderation actions",
					paragraphs: ["When handling a report, moderators can:"],
					items: [
						"Remove content.",
						"Remove and ban someone from a group or channel.",
						"Warn, or lock the chat account.",
						"Limit starting chats with strangers.",
						"For bots: move them to the Restricted tier or turn off their webhooks.",
					],
				},
				{
					title: "Spam",
					paragraphs: [
						"New accounts can send only a limited number of messages to strangers. Bots that break the anti-abuse rules are moved to the Restricted tier automatically.",
					],
				},
				{
					title: "Groups and channels",
					paragraphs: ["To delete your chat account while you own groups or channels, transfer their ownership or delete them first."],
				},
				{
					title: "Bots",
					paragraphs: [
						"You create bots in Settings › Developer Console. A bot token is shown once; the server keeps only a hash. Your bots stop as soon as you start deleting your account and are deleted with it.",
					],
				},
				{
					title: "Leaving",
					paragraphs: ["You can delete your chat account at any time in the app."],
					link: { href: paths.deleteAccount, label: "How to delete your account" },
				},
				{
					title: "Privacy",
					paragraphs: ["The data the app keeps and for how long is in the privacy policy."],
					link: { href: paths.privacy, label: "Privacy policy" },
				},
				{ title: "Contact", paragraphs: [`Questions about these terms: ${OPERATOR_EMAIL}.`], link: mailto(OPERATOR_EMAIL) },
				{
					title: "Being updated",
					pending: true,
					paragraphs: ["Still being added: the legal entity operating the service, the minimum age, limits of liability, the governing law and how disputes are resolved."],
				},
			],
		},
		"delete-account": {
			title: "Delete your account",
			lede: `How to delete your ${appName} chat account and the data that goes with it.`,
			sections: [
				{
					title: "How to delete it",
					steps: [
						`Sign in at ${webHost}.`,
						"Open Settings › Account and go to Delete chat account.",
						`If asked, sign in again at ${idpHost} (deleting needs a sign-in within the last 10 minutes).`,
						"Type your username to confirm, then press Delete account.",
					],
					paragraphs: ["If you own groups or channels, transfer their ownership or delete them first."],
				},
				{
					title: "What happens",
					items: [
						...deletionTicks.en(DELETION_GRACE_DAYS, idpHost),
						"Every device is signed out. Your bots stop at once and are deleted with the account.",
					],
				},
				{
					title: "Cancelling",
					paragraphs: [`Sign in again within ${DELETION_GRACE_DAYS} days and the app offers one choice: cancel the deletion.`],
				},
				{
					title: "What remains after deletion",
					items: [
						"Deleted data stays in backups for up to 14 days.",
						"Reports you sent and the moderation log are kept to handle appeals, showing a deleted account as the reporter.",
					],
				},
				{
					title: `Your ${domain} account`,
					paragraphs: [`Deleting your chat account does not delete your ${domain} account. To delete that, use its account page at ${idpHost}.`],
					link: { href: accountUrl, label: `${domain} account`, kind: "site" },
				},
				{
					title: "Can't sign in?",
					paragraphs: [`Email your request to delete your chat account to ${OPERATOR_EMAIL}, with your username and your ${domain} account's email.`],
					link: mailto(OPERATOR_EMAIL),
				},
			],
		},
	},
};

const zhCN: LegalCopy = {
	updated: `更新于 ${LEGAL_UPDATED["zh-CN"]}`,
	documents: {
		privacy: {
			title: "隐私政策",
			lede: `你使用 ${appName}（${webHost}）时它保存哪些数据、保存在哪里、保存多久，以及你如何导出或删除这些数据。`,
			sections: [
				{
					title: "登录",
					paragraphs: [
						`你在 ${idpHost} 使用 ${domain} 账号登录，可通过 Google、GitHub 或 Apple 登录。聊天应用永远不会看到你的密码。`,
						`你的 Google、GitHub 或 Apple 身份、原始电子邮箱和登录方式由 ${idpHost} 保存，而不是聊天应用。你可以在 ${idpHost}/account 管理或删除你的 ${domain} 账号。`,
					],
				},
				{
					title: "聊天应用保存的数据",
					items: [
						"个人资料：用户名、显示名称、简介，以及你登录账号的 ID。",
						`电子邮箱：你的 ${domain} 账号已验证电子邮箱的副本，每次登录时重新读取。只有在你允许时，他人才能通过电子邮箱找到你（默认：任何人都不能）。`,
						`账号头像：指向你的 ${domain} 账号在 Google 或 GitHub 上头像的链接，每次登录时重新读取（通过 Apple 登录则没有头像，因为 Apple 不提供）。在你尚未向聊天应用上传头像时，只有你能在账号按钮上看到它。`,
						"会话：IP 地址、浏览器或设备，以及使用时间。",
						"消息、表情回应、置顶、已读状态，以及你发送的文件（照片、视频、文件、语音消息）。",
						"联系人、你屏蔽的人，以及你的隐私、通知和自动删除设置。",
						"开启通知时，你浏览器的推送订阅。",
						"你发送的反馈，其中的电子邮箱和电话号码会被遮盖。",
						"你针对某条消息、某个人或某个聊天提交的举报。",
						"浏览器中的技术错误（电子邮箱已遮盖），用于修复问题；不与你的账号关联。",
					],
				},
				{
					title: "数据的用途",
					paragraphs: [
						"提供你注册的服务：在各设备间投递和同步消息、搜索、通知。",
						"部分用途仅在你开启后才使用：推送通知、允许他人通过电子邮箱找到你。",
						"安全和防止滥用：会话、举报、审核日志、备份和日志。",
					],
				},
				{
					title: "存储位置",
					items: [
						"数据库、文件和备份存放在运营者的服务器上；目前没有在该服务器之外存储或备份。",
						"服务器位于越南。",
						`与 ${webHost} 的连接经由 Cloudflare。`,
						`${webHost} 网站使用 Cloudflare Web Analytics 统计页面浏览量，它不设置 Cookie，也不在你的设备上存储任何内容。`,
						"应用日志只记录 ID，从不记录消息内容、电子邮箱或令牌。",
					],
				},
				{
					title: "保存期限",
					items: [
						"个人资料、联系人、设置和反馈：直到你删除聊天账号。",
						"消息：直到被撤回或聊天被删除。",
						"文件：直到不再有消息使用它们，再加 1 天。",
						"网页会话：30 天未使用即结束，最长 90 天。",
						"每条消息的已读人员：7 天。设备间同步日志：30 天。",
						"浏览器错误：90 天。",
						"调用机器人（@bot）时输入的内容：1 天。机器人的群发消息：完成后 30 天。",
						"数据导出：30 天。",
						"备份：每天一份，保留 14 份，因此已删除的数据最多会在备份中保留 14 天。",
						"举报和审核日志：账号删除后仍会保留，用于处理申诉。",
					],
				},
				{
					title: "推送通知",
					paragraphs: [
						pushServicesNote["zh-CN"],
						"可在 设置 › 通知 中关闭通知里的消息预览。",
					],
				},
				{
					title: "机器人和 Mini App",
					items: [
						"机器人由用户创建，运行在其创建者的服务器上。你发给机器人的内容（消息、命令、按钮点击、在 @bot 后输入的内容）会发送到该服务器。",
						"隐私设置同样适用于机器人：机器人看不到你已隐藏的内容。",
						"机器人只会向启动过它的人群发消息。",
						"Mini App 是机器人创建者的网站，在应用内打开并显示其域名。该网站能看到你在其中的操作。",
					],
				},
				{
					title: "在你的设备上",
					paragraphs: [
						"你的浏览器会保存一份聊天副本，以便快速打开并离线使用。该副本未加密，按账号分开保存，并在你退出登录时删除。",
					],
				},
				{
					title: "你的权利",
					items: [
						"选择谁能看到你的最后在线时间和头像，谁能找到你、把你加入群组和给你发消息：设置 › 隐私。",
						"查看你的设备并让其退出登录：设置 › 会话。",
						"导出你的数据：设置 › 账号。导出在后台进行，在应用内下载，每 7 天一次，保留 30 天。其中包含你的个人资料、联系人、屏蔽的人、会话、机器人（不含令牌）、聊天列表，以及你发送的消息和文件；不含他人的消息。",
						"在 6、12 或 24 个月未使用后自动删除你的聊天账号（默认关闭）：设置 › 账号。",
						"随时删除你的聊天账号。",
					],
					link: { href: paths.deleteAccount, label: "如何删除账号" },
				},
				{
					title: "联系方式",
					paragraphs: [
						`关于你个人数据的问题或请求（访问、导出、更正、删除），请发送至 ${OPERATOR_EMAIL}。`,
						"你也可以在应用内使用 设置 › 反馈；回复将通过助手机器人送达。",
					],
					link: mailto(OPERATOR_EMAIL),
				},
				{
					title: "正在更新",
					pending: true,
					paragraphs: ["运营本服务的法律实体名称正在补充中。"],
				},
			],
		},
		terms: {
			title: "使用条款",
			lede: `你使用 ${appName}（${webHost}）服务时适用的规则。`,
			sections: [
				{
					title: "你的账号",
					paragraphs: [`你使用 ${domain} 账号使用本应用。聊天账号仅属于本应用：删除它不会删除你的 ${domain} 账号。`],
				},
				{
					title: "举报内容",
					paragraphs: [
						`你可以因垃圾信息、诈骗、暴力、色情内容或其他原因举报某条消息、某个人或某个聊天。${domain} 的审核人员会审查每一条举报。`,
					],
				},
				{
					title: "审核措施",
					paragraphs: ["处理举报时，审核人员可以："],
					items: [
						"移除内容。",
						"将某人移出群组或频道并封禁。",
						"警告，或锁定聊天账号。",
						"限制其向陌生人发起聊天。",
						"对于机器人：将其移至受限级别，或关闭其 Webhook。",
					],
				},
				{
					title: "垃圾信息",
					paragraphs: [
						"新账号只能向陌生人发送有限数量的消息。违反防滥用规则的机器人会被自动移至受限级别。",
					],
				},
				{
					title: "群组和频道",
					paragraphs: ["如果你拥有群组或频道，删除聊天账号前请先转让其所有权或将其删除。"],
				},
				{
					title: "机器人",
					paragraphs: [
						"你可以在 设置 › 开发者控制台 中创建机器人。机器人令牌只显示一次；服务器只保存其哈希值。你一开始删除账号，你的机器人就会停止运行，并随账号一起删除。",
					],
				},
				{
					title: "离开",
					paragraphs: ["你可以随时在应用内删除你的聊天账号。"],
					link: { href: paths.deleteAccount, label: "如何删除账号" },
				},
				{
					title: "隐私",
					paragraphs: ["应用保存哪些数据以及保存多久，请参阅隐私政策。"],
					link: { href: paths.privacy, label: "隐私政策" },
				},
				{ title: "联系方式", paragraphs: [`关于本条款的问题：${OPERATOR_EMAIL}。`], link: mailto(OPERATOR_EMAIL) },
				{
					title: "正在更新",
					pending: true,
					paragraphs: ["以下内容仍在补充中：运营本服务的法律实体、最低年龄、责任限制、适用法律以及争议解决方式。"],
				},
			],
		},
		"delete-account": {
			title: "删除账号",
			lede: `如何删除你的 ${appName} 聊天账号及其相关数据。`,
			sections: [
				{
					title: "如何删除",
					steps: [
						`在 ${webHost} 登录。`,
						"打开 设置 › 账号，进入“删除聊天账号”。",
						`如有提示，请在 ${idpHost} 重新登录（删除需要最近 10 分钟内登录过）。`,
						"输入你的用户名进行确认，然后点击“删除账号”。",
					],
					paragraphs: ["如果你拥有群组或频道，请先转让其所有权或将其删除。"],
				},
				{
					title: "删除后会发生什么",
					items: [
						...deletionTicks["zh-CN"](DELETION_GRACE_DAYS, idpHost),
						"所有设备都会退出登录。你的机器人会立即停止运行，并随账号一起删除。",
					],
				},
				{
					title: "取消删除",
					paragraphs: [`在 ${DELETION_GRACE_DAYS} 天内重新登录，应用会提供一个选项：取消删除。`],
				},
				{
					title: "删除后仍保留的内容",
					items: [
						"已删除的数据最多会在备份中保留 14 天。",
						"你提交的举报和审核日志会保留，用于处理申诉，举报人显示为已删除的账号。",
					],
				},
				{
					title: `你的 ${domain} 账号`,
					paragraphs: [`删除聊天账号不会删除你的 ${domain} 账号。如需删除该账号，请前往 ${idpHost} 的账号页面。`],
					link: { href: accountUrl, label: `${domain} 账号`, kind: "site" },
				},
				{
					title: "无法登录？",
					paragraphs: [`请将删除聊天账号的请求发送至 ${OPERATOR_EMAIL}，并附上你的用户名和你 ${domain} 账号的电子邮箱。`],
					link: mailto(OPERATOR_EMAIL),
				},
			],
		},
	},
};

export const legalCopy: Readonly<Record<Locale, LegalCopy>> = { vi, en, "zh-CN": zhCN };
