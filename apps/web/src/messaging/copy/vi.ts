// Vietnamese copy of the messaging UI (release R1), taken from the approved
// mockups. Loaded with the messaging chunk so the R0 shell stays small;
// en.ts must provide the same keys.
import type { HookStopReason } from "@achoo254/chat-core";

/** The chat kind in copy that names it: channels are never called groups. */
const kind = (channel: boolean): string => (channel ? "kênh" : "nhóm");

export const vi = {
	common: {
		cancel: "Huỷ",
		close: "Đóng",
		back: "Quay lại",
		done: "Xong",
		retry: "Thử lại",
		you: "Bạn",
		copied: "Đã sao chép",
		failed: "Không thực hiện được, thử lại sau ít phút.",
		/** A private chat the person's settings refuse; never says which setting (or a block). */
		privateRefused: "Không thể nhắn tin cho người này lúc này.",
		privateRefusedInviteHint: "Bạn có thể mời họ vào nhóm bằng link mời.",
		/** Anti-spam: the daily cap on new chats with strangers, and the pause while reports are reviewed. */
		strangerLimit: "Hôm nay bạn đã bắt đầu nhiều chat với người chưa quen. Hãy thử lại sau, hoặc nhờ họ thêm bạn vào danh bạ.",
		strangerPaused: "Tạm thời bạn chưa bắt đầu được chat với người chưa quen vì tài khoản đang được đội kiểm duyệt xem xét.",
		loadFailed: "Không tải được dữ liệu. Kiểm tra kết nối mạng rồi thử lại.",
		loading: "Đang tải…",
	},
	folders: {
		nav: "Thư mục chat",
		filterTabs: "Lọc chat",
		all: "Tất cả",
		private: "Cá nhân",
		group: "Nhóm",
		bot: "Bot",
		unread: "Chưa đọc",
		settings: "Cài đặt",
		contacts: "Danh bạ",
		account: "Tài khoản của bạn",
		unreadChats: (n: number) => `${n} chat chưa đọc`,
		emptyTitle: "Chưa có chat nào ở đây",
		emptyTitleUnread: "Bạn đã đọc hết",
		emptyBody: {
			all: "Bấm + để nhắn cho một người, tạo nhóm hoặc kênh.",
			private: "Chat riêng với một người sẽ hiện ở bộ lọc này.",
			group: "Nhóm bạn tham gia sẽ hiện ở bộ lọc này.",
			bot: "Chat với bot sẽ hiện ở bộ lọc này.",
			unread: "Chat có tin chưa đọc sẽ hiện ở bộ lọc này.",
		},
		showAll: "Xem tất cả chat",
		inviteTitle: "Mời đồng đội vào cùng",
		inviteBody: "Chat vui hơn khi cả nhóm ở đây. Tạo nhóm rồi gửi link mời cho đồng đội qua email hay app bạn đang dùng.",
		inviteCreateGroup: "Tạo nhóm và mời",
		inviteMessageOne: "Nhắn cho một người",
	},
	/** "đang gõ…" (#list-states): private chats say what the person does, groups who does it. */
	typing: {
		typing: "đang gõ…",
		voice: "đang ghi âm…",
		photo: "đang gửi ảnh…",
		video: "đang gửi video…",
		document: "đang gửi file…",
		who: (names: readonly string[], action: string): string =>
			names.length > 2 ? `${names.length} người đang gõ…` : `${names.join(" và ")} ${action}`,
	},
	list: {
		label: "Danh sách chat",
		search: "Tìm chat và tin nhắn",
		searchPlaceholder: "Tìm kiếm",
		newChat: "Tạo chat mới",
		/** Title of the Chat mới dialog, shown at once while its content loads. */
		newChatTitle: "Chat mới",
		firstLoad: "Đang tải danh sách chat lần đầu…",
		draft: "Nháp:",
		typeGroup: "Nhóm",
		typeForum: "Nhóm có chủ đề",
		typeChannel: "Kênh",
		typeBot: "Bot",
		muted: "Đã tắt thông báo",
		pinned: "Đã ghim",
		mention: "Có người nhắc bạn",
		unreadMuted: (n: number) => `${n} tin chưa đọc, đã tắt thông báo`,
		markedUnread: "Đánh dấu chưa đọc",
		rowActions: (name: string) => `Thao tác với chat ${name}`,
		resize: "Độ rộng danh sách chat",
		read: "Đã xem",
		sent: "Đã gửi",
		today: "Hôm nay",
		yesterday: "Hôm qua",
		noMessages: "Chưa có tin nhắn",
		deletedChat: "Chat đã xoá",
		savedChat: "Cloud của tôi",
		savedEmpty: "Ghi chú, link và file trên mọi máy",
	},
	convo: {
		pick: "Chọn một cuộc trò chuyện",
		pickBody: "Chọn chat ở danh sách bên trái, hoặc bấm + để bắt đầu chat mới.",
		backToList: "Về danh sách chat",
		searchInChat: "Tìm trong chat",
		info: "Thông tin chat",
		members: (n: number) => `${n} thành viên`,
		membersOnline: (n: number, online: number) => `${n} thành viên · ${online} đang hoạt động`,
		/** The online part of the group header, left out on phones. */
		onlinePart: (online: number) => ` · ${online} đang hoạt động`,
		subscribers: (n: number) => `Kênh · ${n} người đăng ký`,
		channelAdmin: "Kênh · bạn là admin",
		channelOwner: "Kênh · bạn là chủ kênh",
		connecting: "Đang kết nối…",
		waitingNetwork: "Chờ mạng",
		offlineBanner: (n: number) => (n > 0 ? `Ngoại tuyến — ${n} tin sẽ gửi khi có mạng` : "Ngoại tuyến"),
		notFound: "Không mở được chat này",
		notFoundBody: "Chat không còn trong danh sách của bạn, hoặc bạn không còn là thành viên.",
		left: "Bạn không còn là thành viên của chat này.",
		/** The user left a group or channel, or the cause is unknown (no longer a member). */
		leftChat: (channel: boolean): string => (channel ? "Bạn không còn là người đăng ký của kênh này." : "Bạn không còn là thành viên của nhóm này."),
		/** An admin removed the user (by default with a ban). */
		removedChat: (channel: boolean): string => (channel ? "Bạn đã bị xoá khỏi kênh này." : "Bạn đã bị xoá khỏi nhóm này."),
		closeChat: "Đóng chat",
		loadFailed: "Không tải được tin nhắn. Kiểm tra kết nối mạng rồi thử lại.",
		/** The server refused the history (not a network problem); retrying cannot help. */
		refused: "Bạn không có quyền xem tin nhắn của chat này.",
		toBottom: (n: number) => (n > 0 ? `Xuống tin mới nhất, ${n} tin chưa đọc` : "Xuống tin mới nhất"),
		toMention: (n: number) => `Tới tin nhắc bạn, ${n} tin`,
		unreadDivider: "Tin chưa đọc",
		unreadDividerTopic: "Tin chưa đọc trong chủ đề này",
		messages: "Tin nhắn",
		mute: "Tắt thông báo",
		unmute: "Bật thông báo",
		readOnly: "Bạn không có quyền gửi tin trong chat này.",
		deletedPeer: "Không nhắn tin được cho tài khoản đã xoá.",
		savedSubtitle: "Chỉ mình bạn thấy · đồng bộ mọi máy",
	},
	pinned: {
		label: "Tin ghim",
		hide: "Ẩn thanh tin ghim",
		hidden: "Đã ẩn thanh tin ghim ở phía bạn. Mở lại trong Thông tin chat",
		show: "Hiện thanh tin ghim",
		jump: "Nhảy tới tin ghim",
		counter: (index: number, count: number) => `Tin ghim ${index}/${count}`,
		jumpTo: (index: number, count: number) => `Nhảy tới tin ghim ${index}/${count}`,
		all: (count: number) => `Tất cả tin ghim, ${count} tin`,
	},
	message: {
		edited: "đã sửa",
		forwardedFrom: "Chuyển tiếp từ",
		viaBot: "qua",
		sending: "Đang gửi",
		queued: "Chờ gửi",
		sentTick: "Đã gửi",
		/** Bell-off mark on the time of a silent message (an incoming webhook posting without a notification). */
		silent: "Gửi im lặng, không thông báo",
		read: "Đã xem",
		failed: "Chưa gửi được",
		notSent: "Chưa gửi được",
		resend: "Gửi lại",
		spoiler: "Nội dung ẩn, bấm để hiện",
		copyCode: "Sao chép đoạn code",
		codeCopied: "Đã sao chép đoạn code",
		/** The menu of an e-mail address in a message: copy it or write to it. */
		emailMenu: (email: string) => `Email ${email}`,
		copyEmail: "Sao chép",
		emailCopied: "Đã sao chép email",
		sendMail: "Gửi mail",
		/** A tapped @username that the server does not know (or that hides from search). */
		mentionNotFound: (username: string) => `Không tìm thấy @${username}`,
		/** Tooltip of a #hashtag: tapping it searches the chat for it. */
		searchHashtag: (tag: string) => `Tìm ${tag} trong chat`,
		unsupportedTitle: "Tin này cần phiên bản mới hơn",
		unsupportedBody: (name: string) => `${name} gửi một loại tin mà bản app này chưa hiển thị được.`,
		reload: "Tải lại để cập nhật",
		media: "Bản app này chưa hiển thị được ảnh, video và file. Nội dung đi kèm ở bên dưới.",
		mediaPreview: "Ảnh, video hoặc file",
		/** List and quote previews of a message without text, by kind of file. */
		mediaKind: { photo: "Ảnh", video: "Video", voice: "Tin thoại", audio: "Âm thanh", document: "File", unknown: "File" },
		integration: (label: string) => `Tích hợp: ${label}`,
		/** An integration alert edited in place (firing → resolved), instead of "đã sửa". */
		updated: "đã cập nhật",
		alertFiring: "Firing",
		alertResolved: "Resolved",
		opensExternal: "(mở trang ngoài)",
		/** A reaction pill shown as a count: "👍 3 người, gồm bạn". */
		reaction: (emoji: string, count: number, mine: boolean) => `${emoji} ${count} người${mine ? ", gồm bạn" : ""}`,
		/** A reaction pill with faces: the latest people (up to 3; "bạn" for you), "và n người khác" for the rest. */
		reactionBy: (emoji: string, names: readonly string[], count: number) =>
			`${emoji} ${count} người: ${names.join(", ")}${count > names.length ? ` và ${count - names.length} người khác` : ""}`,
		/** You, inside a list of names. */
		youInList: "bạn",
		reactions: "Biểu cảm",
		reactionsHint: "Bấm để thả hoặc bỏ · chuột phải hoặc nhấn giữ để xem ai đã thả",
		recalled: "Tin nhắn đã thu hồi",
		unknownUser: "Người dùng",
		/** An account deleted by its owner (or waiting for deletion). */
		deletedAccount: "Tài khoản đã xoá",
		deleted: "Tin nhắn đã thu hồi",
		quickActions: (name: string) => `Thao tác nhanh với tin của ${name}`,
		quickActionsMine: "Thao tác nhanh với tin của bạn",
		react: "Thả cảm xúc",
		reply: "Trả lời",
		forward: "Chuyển tiếp",
		more: "Thêm thao tác",
	},
	system: {
		chatCreated: (actor: string, title: string, channel: boolean) => `${actor} đã tạo ${kind(channel)} “${title}”`,
		membersAdded: (actor: string, names: string) => `${actor} đã thêm ${names}`,
		memberLeft: (actor: string, channel: boolean) => `${actor} đã rời ${kind(channel)}`,
		memberRemoved: (actor: string, name: string, channel: boolean) => `${actor} đã xoá ${name} khỏi ${kind(channel)}`,
		titleChanged: (actor: string, title: string, channel: boolean) => `${actor} đã đổi tên ${kind(channel)} thành “${title}”`,
		photoChanged: (actor: string, channel: boolean) => `${actor} đã đổi ảnh ${kind(channel)}`,
		photoRemoved: (actor: string, channel: boolean) => `${actor} đã xoá ảnh ${kind(channel)}`,
		pinned: (actor: string, text: string) => (text === "" ? `${actor} đã ghim một tin` : `${actor} đã ghim “${text}”`),
		historyOn: (actor: string) => `${actor} đã bật: thành viên mới xem được lịch sử`,
		historyOff: (actor: string) => `${actor} đã tắt: thành viên mới xem được lịch sử`,
		modeChanged: "Nhóm đã chuyển sang chế độ nhóm lớn (hơn 200 thành viên)",
		joinedByInvite: (actor: string) => `${actor} đã tham gia bằng link mời`,
		/** The user's Mini App sent data to the bot; `button` is "" for the bot's main Mini App. */
		miniAppData: (button: string) => (button === "" ? "Đã gửi dữ liệu tới bot" : `Đã gửi dữ liệu từ “${button}” tới bot`),
		/** An incoming webhook stopped (mockups/integrations.html#hook-disabled); `actor` is the admin, unused when the server turned it off. */
		hookStopped: (actor: string, name: string, reason: HookStopReason, channel: boolean): string => {
			switch (reason) {
				case "disabled":
					return `${actor} đã tắt webhook “${name}”`;
				case "deleted":
					return `${actor} đã xoá webhook “${name}”`;
				case "creator_not_admin":
					return `Webhook “${name}” đã tự tắt vì người tạo không còn là admin`;
				case "creator_left":
					return `Webhook “${name}” đã tự tắt vì người tạo đã rời ${kind(channel)}`;
				case "by_moderator":
					return `Webhook “${name}” đã bị đội kiểm duyệt tắt`;
				case "unknown":
					return `Webhook “${name}” đã tắt`;
			}
		},
		unsupported: "Sự kiện mà bản app này chưa hiển thị được",
		and: " và ",
	},
	composer: {
		label: (name: string) => `Tin nhắn tới ${name}`,
		placeholder: (name: string) => `Nhập tin nhắn tới ${name}`,
		/** "Cloud của tôi" (mockups/chat.html#first-run). */
		placeholderSaved: "Ghi chú vào Cloud của tôi",
		placeholderGroup: (name: string) => `Nhập @ để nhắc tên, tin nhắn tới ${name}`,
		hint: "Enter gửi · Shift+Enter xuống dòng",
		placeholderOffline: "Tin sẽ gửi khi có mạng",
		channelLabel: "Bài đăng",
		channelPlaceholder: "Đăng bài lên kênh",
		send: "Gửi",
		post: "Đăng",
		emoji: "Emoji",
		replyCancelled: "Đã huỷ trả lời",
		editCancelled: "Đã huỷ sửa, tin giữ nguyên",
		save: "Lưu",
		noPreviewDone: "Tin sẽ gửi không kèm xem trước link",
		tooLong: (max: number) => `Tin dài quá ${max} ký tự`,
		sendFailed: "Không lưu được tin để gửi. Thử lại.",
		attach: "Đính kèm",
		attachMenu: "Đính kèm",
		attachMedia: "Ảnh hoặc video",
		attachFile: "File",
		attachMax: (size: string) => `tối đa ${size}`,
		record: "Ghi âm tin thoại",
		caption: "Thêm chú thích…",
		dropTitle: "Thả file để gửi",
		dropBody: (n: number, size: string) =>
			`${n > 0 ? `${n} file · ` : ""}ảnh và video gửi thành album, file khác gửi dạng tài liệu. Tối đa ${size} mỗi file.`,
		mediaFailed: "Chưa gửi được file, thử lại sau ít phút.",
	},
	info: {
		online: "Đang hoạt động",
		justNow: "Vừa truy cập",
		minutesAgo: (n: number) => `Truy cập ${n} phút trước`,
		hoursAgo: (n: number) => `Truy cập ${n} giờ trước`,
		lastSeenOn: (date: string) => `Truy cập ngày ${date}`,
		recently: "Truy cập gần đây",
		lastWeek: "Truy cập trong tuần",
		lastMonth: "Truy cập trong tháng",
		longAgo: "Truy cập đã lâu",
		bot: "Bot",
	},
	topics: {
		/** The default topic every forum starts with (the server names it "General"). */
		general: "Chung",
		list: (group: string) => `Chủ đề của ${group}`,
		topicsLabel: "Chủ đề",
		backToChats: "Về danh sách chat",
		searchInTopic: "Tìm trong chủ đề",
		info: "Thông tin chủ đề",
		messageCount: (n: number) => `${n} tin nhắn`,
		closed: "Đã đóng, chỉ admin gửi được",
		closedShort: "Đã đóng",
		closedHead: (n: number) => `Đã đóng · ${n} tin nhắn`,
		closedBar: "Chủ đề đã đóng. Chỉ admin gửi được tin và mở lại.",
		closedPlaceholder: "Chủ đề đã đóng, chỉ admin gửi được",
		hiddenSummary: (n: number) => `Đã ẩn · ${n} · chỉ admin thấy`,
		hiddenNote: "Ẩn chỉ bỏ chủ đề khỏi danh sách; thành viên vẫn tìm thấy tin trong chủ đề ẩn.",
		menu: (name: string) => `Thao tác với chủ đề ${name}`,
		pin: "Ghim chủ đề",
		unpin: "Bỏ ghim chủ đề",
		close: "Đóng chủ đề",
		reopenTopic: "Mở lại chủ đề",
		hide: "Ẩn chủ đề",
		show: "Hiện lại",
		pinnedDone: "Đã ghim chủ đề lên đầu danh sách",
		closedDone: "Đã đóng chủ đề, thành viên chỉ còn đọc được",
		reopenedDone: (name: string) => `Đã mở lại chủ đề ${name}`,
		hiddenDone: "Đã ẩn chủ đề với thành viên",
		shownDone: (name: string) => `Đã hiện lại chủ đề ${name}`,
		hiddenBy: (name: string, date: string) => `Ẩn bởi ${name} · ${date}`,
		empty: "Chưa có tin trong chủ đề này",
	},
	time: {
		weekdays: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],
	},
	bot: {
		/** Tag after a bot's name in group messages (mockups/chat.html). */
		tag: "bot",
		/** Header subtitle of a private chat with a bot: "@deploy_bot · bot". */
		subtitle: (username: string) => (username === "" ? "bot" : `@${username} · bot`),
		/** A callback button while the bot has not answered (mockups/bots.html#inline-keyboard). */
		waiting: "Đang chờ bot",
		notResponding: "Bot không phản hồi",
		/** Composer of a bot chat (mockups/bots.html#commands, #reply-keyboard). */
		menu: "Lệnh của bot",
		hideKeyboard: "Ẩn bàn phím của bot",
		showKeyboard: "Hiện bàn phím của bot",
	},
	notify: {
		/** Shown instead of the message when its preview is off. */
		hiddenBody: "Bạn có tin nhắn mới",
	},
};

export type MessagingCopy = typeof vi;
