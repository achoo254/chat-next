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
export const LEGAL_UPDATED = { vi: "20/10/2026", en: "20 October 2026" } as const;

const { appName, domain, webHost, idpHost, accountUrl, primaryTenant } = brand;

/**
 * The operator's contact for privacy, terms and deletion requests, and where
 * its servers are: facts of the primary tenant's service only. A tenant run
 * by someone else shows its in-app channel and no location.
 */
const OPERATOR = primaryTenant ? { email: "quocdat254@gmail.com", inVietnam: true, cloudflare: true } : null;
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
						`Bạn đăng nhập bằng tài khoản ${domain} ở ${idpHost}, bằng Google hoặc GitHub. App chat không bao giờ thấy mật khẩu của bạn.`,
						`Danh tính Google hoặc GitHub, email gốc và cách đăng nhập do ${idpHost} giữ, không phải app chat. Bạn quản lý hoặc xoá tài khoản ${domain} ở ${idpHost}/account.`,
					],
				},
				{
					title: "Dữ liệu app chat giữ",
					items: [
						"Hồ sơ: username, tên hiển thị, giới thiệu và mã tài khoản ở nơi đăng nhập.",
						`Email: bản sao email đã xác minh của tài khoản ${domain}, đọc lại mỗi lần đăng nhập. Người khác chỉ tìm được bạn bằng email khi bạn cho phép (mặc định: Không ai).`,
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
						...(OPERATOR?.inVietnam === true ? ["Máy chủ đặt tại Việt Nam."] : []),
						...(OPERATOR?.cloudflare === true ? [`Kết nối tới ${webHost} đi qua Cloudflare.`] : []),
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
						...(OPERATOR === null ? [] : [`Gửi câu hỏi hoặc yêu cầu về dữ liệu cá nhân (xem, xuất, sửa, xoá) tới ${OPERATOR.email}.`]),
						"Trong app, bạn cũng gửi được ở Cài đặt › Góp ý; câu trả lời đến qua bot Trợ lý.",
					],
					...(OPERATOR === null ? {} : { link: mailto(OPERATOR.email) }),
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
				...(OPERATOR === null
					? []
					: [{ title: "Liên hệ", paragraphs: [`Câu hỏi về các điều khoản này: ${OPERATOR.email}.`], link: mailto(OPERATOR.email) }]),
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
				...(OPERATOR === null
					? []
					: [
							{
								title: "Không đăng nhập được?",
								paragraphs: [
									`Gửi yêu cầu xoá tài khoản chat tới ${OPERATOR.email}, ghi rõ username của bạn và email của tài khoản ${domain}.`,
								],
								link: mailto(OPERATOR.email),
							},
						]),
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
						`You sign in with your ${domain} account at ${idpHost}, using Google or GitHub. The chat app never sees your password.`,
						`Your Google or GitHub identity, original email and sign-in methods are kept by ${idpHost}, not by the chat app. Manage or delete your ${domain} account at ${idpHost}/account.`,
					],
				},
				{
					title: "What the chat app keeps",
					items: [
						"Profile: username, display name, bio and the id of your sign-in account.",
						`Email: a copy of your ${domain} account's verified email, read again at every sign-in. Others find you by email only if you allow it (default: Nobody).`,
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
						...(OPERATOR?.inVietnam === true ? ["The servers are in Vietnam."] : []),
						...(OPERATOR?.cloudflare === true ? [`Connections to ${webHost} go through Cloudflare.`] : []),
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
						...(OPERATOR === null ? [] : [`Send questions or requests about your personal data (access, export, correction, deletion) to ${OPERATOR.email}.`]),
						"In the app you can also use Settings › Feedback; replies come through the Assistant bot.",
					],
					...(OPERATOR === null ? {} : { link: mailto(OPERATOR.email) }),
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
				...(OPERATOR === null
					? []
					: [{ title: "Contact", paragraphs: [`Questions about these terms: ${OPERATOR.email}.`], link: mailto(OPERATOR.email) }]),
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
				...(OPERATOR === null
					? []
					: [
							{
								title: "Can't sign in?",
								paragraphs: [
									`Email your request to delete your chat account to ${OPERATOR.email}, with your username and your ${domain} account's email.`,
								],
								link: mailto(OPERATOR.email),
							},
						]),
			],
		},
	},
};

export const legalCopy: Readonly<Record<Locale, LegalCopy>> = { vi, en };
