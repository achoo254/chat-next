// Vietnamese copy of the incoming webhook screens (mockups/integrations.html).
// Loaded with those screens only; copy-en.ts must provide the same keys.
import type { HookAuditAction, HookChanges, HookFormat } from "./api.ts";

/** The chat kind in copy that names it: channels are never called groups. */
const kind = (channel: boolean): string => (channel ? "kênh" : "nhóm");

export const viHooks = {
	title: (channel: boolean): string => `Webhook của ${kind(channel)}`,
	crumb: "Webhook",
	backToAdmin: (channel: boolean): string => `Quay lại quản lý ${kind(channel)}`,
	backToList: "Về danh sách webhook",
	create: "Tạo webhook",
	creating: "Đang tạo…",
	manage: "Quản lý",
	manageName: (name: string) => `Quản lý webhook ${name}`,
	columns: { hook: "Webhook", format: "Định dạng", creator: "Tạo bởi", lastUsed: "Nhận gần nhất", state: "Trạng thái", actions: "Thao tác" },
	neverUsed: "Chưa nhận",
	emptyTitle: "Chưa có webhook",
	emptyBody: (channel: boolean): string =>
		`Webhook cho công cụ giám sát, CI/CD hay script gửi tin vào ${kind(channel)} qua một URL bí mật. Tin hiện với nhãn "Tích hợp: <tên>".`,
	membersNote: (channel: boolean): string =>
		`${channel ? "Người đăng ký" : "Thành viên thường"} thấy tin tích hợp trong chat, không thấy danh sách này.`,
	limitReached: (max: number) => `Đã đủ ${max} webhook, mức tối đa của một chat. Xoá webhook không dùng để tạo thêm.`,
	state: {
		active: "Hoạt động",
		disabled: "Đã tắt",
		auto_disabled: "Đã tự tắt",
		rotating: "Đang xoay secret",
	},
	stateSub: {
		creatorNotAdmin: "Người tạo không còn là admin",
		creatorLeft: (channel: boolean): string => `Người tạo đã rời ${kind(channel)}`,
		byAdmin: "Admin đã tắt",
		byModerator: "Đội kiểm duyệt đã tắt",
		silent: "Gửi im lặng",
		oldUrl: (left: string) => `URL cũ hết hạn sau ${left}`,
	},
	formats: {
		native: { name: "Native JSON", note: "text, nút, group_key, idempotency_key. Cho script và Jenkins." },
		slack: { name: "Slack-compatible", note: "Grafana, Uptime Kuma, GitLab qua Mattermost. Hiểu mrkdwn." },
		alertmanager: { name: "Alertmanager", note: "Cảnh báo cùng groupKey cập nhật tại chỗ, firing sang resolved." },
		grafana: { name: "Grafana", note: "Contact point kiểu webhook: cập nhật tại chỗ như Alertmanager, có nút Dashboard và Panel." },
		gitlab: { name: "GitLab", note: "Webhook dự án: push, merge request, pipeline, deployment, issue, release." },
	} satisfies Record<HookFormat, { name: string; note: string }>,
	form: {
		name: "Tên",
		nameHint: 'Người trong nhóm thấy tên này ở nhãn "Tích hợp: <tên>". Webhook không giả được tên người dùng.',
		nameRequired: "Nhập tên webhook",
		nameTooLong: (max: number) => `Tên dài tối đa ${max} ký tự`,
		format: "Định dạng",
		formatHint: "Định dạng quyết định đuôi URL và cách đọc payload.",
		allowAlert: "Cho phép tin ưu tiên Cảnh báo",
		allowAlertNote: 'Payload đặt priority "alert" sẽ đi làn push nhanh nhất. Tắt thì mọi tin của webhook là ưu tiên thường.',
		silent: "Gửi im lặng",
		silentNote: "Tin vào chat, không rung, không phát thông báo.",
		previewTitle: "Tin sẽ trông như thế này",
		previewText: "CPU cao trên lab-174",
		previewNote: "Ai có URL đều gửi được tin vào nhóm, nên URL chỉ hiện một lần sau khi tạo.",
		limit: (max: number) => `Mỗi chat có tối đa ${max} webhook.`,
		invalid: "Server không nhận tên hoặc định dạng này. Kiểm tra lại rồi thử lại.",
	},
	oneTime: {
		createdTitle: (name: string) => `Đã tạo webhook ${name}`,
		rotatedTitle: (name: string) => `URL mới của ${name}`,
		warn: (chat: string) => `URL chỉ hiện một lần. Lưu ngay vào nơi an toàn; ai có URL đều gửi được tin vào ${chat}.`,
		urlLabel: (format: string) => `URL webhook (${format})`,
		copyUrl: "Sao chép URL",
		urlCopied: "Đã sao chép URL",
		tryNow: "Thử ngay",
		copyCommand: "Sao chép lệnh",
		commandCopied: "Đã sao chép lệnh",
		greeting: (name: string) => `Xin chào từ ${name}`,
		response: (body: string) => `Phản hồi: ${body}`,
		saved: "Tôi đã lưu URL",
		savedFirst: "Bật \"Tôi đã lưu URL\" trước khi đóng",
		done: "Xong",
		hidden: "URL đã được che, chỉ còn tên và trạng thái",
	},
	detail: {
		gone: "Webhook này không còn. Có thể admin khác đã xoá.",
		info: "Webhook",
		format: "Định dạng",
		createdBy: "Tạo bởi",
		createdLine: (name: string, when: string) => `${name} · ${when}`,
		lastUsed: "Nhận gần nhất",
		silent: "Gửi im lặng",
		allowAlert: "Tin ưu tiên Cảnh báo",
		on: "Bật",
		off: "Tắt",
		allowed: "Cho phép",
		notAllowed: "Không cho phép",
		receiving: "Nhận tin",
		receivingNote: "Tắt thì request tới URL bị từ chối, URL vẫn giữ nguyên.",
		turnedOn: (name: string) => `Đã bật ${name}`,
		turnedOff: (name: string) => `Đã tắt ${name}, request tới URL đang bị từ chối`,
		creatorNotAdmin: "Người tạo không còn là admin. Nhận lại webhook để bật.",
		autoDisabledBanner: (creator: string, when: string, left: boolean, channel: boolean): string =>
			`Webhook đã tự tắt vì ${creator} ${left ? `đã rời ${kind(channel)}` : `không còn là admin ${kind(channel)}`} (${when}). Request tới URL này đang bị từ chối.`,
		disabledBanner: (when: string) => `Webhook đang tắt từ ${when}. Request tới URL này bị từ chối cho tới khi bật lại.`,
		moderatorBanner: (when: string) => `Đội kiểm duyệt đã tắt webhook này lúc ${when}. Admin không bật lại hay nhận lại được.`,
		takeOver: "Nhận lại webhook",
		takeOverNote: "Bạn thành người tạo mới; webhook chạy lại ngay với định dạng và cài đặt cũ.",
		rotateOnTakeOver: "Xoay secret khi nhận lại",
		rotateOnTakeOverNote: (creator: string) =>
			`Mặc định tắt để cảnh báo không gián đoạn. Bật nếu không muốn ${creator} dùng URL cũ nữa; URL mới hiện một lần.`,
		takenOver: "Đã nhận lại webhook, URL giữ nguyên",
		takenOverRotated: "Đã nhận lại webhook với URL mới",
		secretTitle: "URL và secret",
		secretNote: "Server chỉ giữ hash của secret, nên URL đầy đủ chỉ hiện lúc tạo, xoay secret hoặc nhận lại có xoay.",
		currentSecret: "Secret hiện tại",
		currentSecretSub: (when: string, by: string) => `Tạo ${when} bởi ${by}`,
		accepting: "Đang nhận",
		refused: "Bị từ chối",
		previousSecret: "Secret cũ",
		previousSecretSub: "Vẫn nhận trong thời gian ân hạn",
		expiresIn: "Hết hạn sau",
		graceProgress: "Thời gian ân hạn đã qua",
		rotate: "Xoay secret",
		revokePrevious: "Thu hồi secret cũ ngay",
		revokedPrevious: "Đã thu hồi secret cũ, chỉ URL mới còn hiệu lực",
		noPrevious: "Secret cũ đã hết hạn hoặc đã bị thu hồi",
		statsTitle: "Số liệu",
		window: "Khoảng thời gian",
		windows: { day: "24 giờ", week: "7 ngày", month: "30 ngày" },
		accepted: "Đã nhận",
		acceptedSub: "Request được chấp nhận",
		delivered: "Đã giao realtime",
		deliveredSub: "Tới ít nhất một phiên online",
		failed: "Lỗi",
		failedSub: "Không tạo được tin",
		noPerMember: "Không theo dõi việc giao tới từng thành viên, chỉ có bộ đếm tổng. Muốn biết ai đã xem, dùng \"Đã xem\" trên tin (nhóm nhỏ).",
		failureColumns: { reason: "Lý do lỗi", count: "Số lần", last: "Gần nhất" },
		noFailures: "Không có lỗi trong khoảng này.",
		deadTitle: "Request lỗi",
		deadNote: "Request không xử lý được, giữ 30 ngày, mới nhất trước. Body giữ tối đa 16 KiB.",
		deadEmpty: "Chưa có request lỗi.",
		deadStatus: (status: number) => `HTTP ${status}`,
		deadContentType: (type: string) => `Content-Type: ${type === "" ? "(không có)" : type}`,
		deadBody: "Body",
		deadEmptyBody: "(body rỗng)",
		deadTruncated: "Body dài hơn 16 KiB, phần sau đã bị cắt.",
		more: "Xem thêm",
		guideTitle: "Hướng dẫn kết nối",
		copySnippet: "Sao chép đoạn cấu hình",
		snippetCopied: "Đã sao chép đoạn cấu hình",
		guideUrl: "{URL} là URL bạn đã lưu khi tạo webhook, đã gồm đuôi định dạng.",
		dangerTitle: "Xoá webhook",
		dangerNote: "URL ngừng nhận ngay. Tin đã gửi vẫn ở trong chat, nhật ký vẫn giữ.",
		delete: "Xoá webhook",
	},
	failures: {
		rate_limited: "Vượt rate limit",
		payload_too_large: "Payload lớn hơn 64 KB",
		invalid_json: "JSON sai định dạng",
		invalid_payload: "Payload không đúng định dạng đã chọn",
		text_empty: "Không có nội dung",
		text_too_long: "Văn bản dài quá 4096 ký tự",
		url_not_allowed: "Link dùng scheme không cho phép",
		hook_disabled: "Webhook đang tắt",
		chat_unavailable: "Chat không còn",
		internal: "Lỗi máy chủ",
	} as Readonly<Record<string, string>>,
	guides: {
		native: [
			"Tạo webhook định dạng Native JSON; bật Gửi im lặng nếu chỉ báo build thành công.",
			"Lưu URL vào Jenkins Credentials (Secret text) với id chat-hook-url.",
			"Thêm bước post gọi curl; idempotency_key chống gửi trùng khi Jenkins thử lại.",
		],
		slack: [
			"Grafana: Alerting → Contact points → Add contact point, chọn Integration Slack, dán URL vào Webhook URL.",
			"GitLab: Settings → Integrations → Mattermost notifications, dán URL vào Webhook (GitLab chặn URL Discord, tích hợp Slack mới bắt buộc cài app).",
			"Uptime Kuma: Settings → Notifications → Setup Notification, chọn Slack, dán URL như đoạn bên cạnh.",
		],
		alertmanager: [
			"Thêm receiver webhook_configs trỏ tới URL, bật send_resolved.",
			"Reload Alertmanager. Cảnh báo cùng groupKey sửa tại chỗ một tin, không tạo tin mới.",
		],
		grafana: [
			"Grafana: Alerting → Contact points → Add contact point, chọn Integration Webhook.",
			"Dán URL, method POST, bấm Test: tin của webhook hiện trong chat.",
			"Cảnh báo cùng nhóm sửa tại chỗ một tin, firing sang resolved.",
		],
		gitlab: [
			"GitLab: Settings → Webhooks → Add new webhook.",
			"Dán URL, chọn sự kiện (push, merge request, pipeline, deployment), bật SSL verification.",
			"Bấm Test → Push events: tin của webhook hiện trong chat. Merge request và pipeline cập nhật tại chỗ.",
		],
	} satisfies Record<HookFormat, readonly string[]>,
	rotateDialog: {
		title: (name: string) => `Xoay secret của ${name}?`,
		note: "Tạo URL mới, hiện một lần. URL cũ vẫn chạy thêm 7 ngày để kịp đổi cấu hình ở công cụ.",
		revokeNow: "Thu hồi URL cũ ngay",
		revokeNowNote: "Dùng khi URL cũ đã lộ: request tới URL cũ bị từ chối ngay.",
		confirm: "Xoay secret",
	},
	deleteDialog: {
		title: (name: string) => `Xoá webhook ${name}?`,
		note: "URL ngừng nhận ngay và không khôi phục được. Tin đã gửi vẫn ở trong chat, nhật ký vẫn giữ.",
		confirm: "Xoá webhook",
		deleted: (name: string) => `Đã xoá webhook ${name}`,
	},
	editDialog: {
		open: "Sửa cài đặt",
		title: (name: string) => `Sửa webhook ${name}`,
		nameHint: 'Tên mới hiện ở nhãn "Tích hợp: <tên>" của các tin sau; tin đã gửi giữ tên cũ.',
		formatNote: (format: string) => `Định dạng ${format} gắn với URL nên không đổi được. Cần định dạng khác thì tạo webhook mới.`,
		save: "Lưu",
		saving: "Đang lưu…",
		saved: (name: string) => `Đã lưu cài đặt của ${name}`,
	},
	audit: {
		title: "Nhật ký",
		chatNote: "Mọi thao tác trên webhook của chat, cả webhook đã xoá.",
		empty: "Chưa có thao tác nào.",
		server: "Hệ thống",
		action: (action: HookAuditAction, actor: string, hook: string, detail: string): string => {
			switch (action) {
				case "created":
					return `${actor} đã tạo ${hook}`;
				case "secret_rotated":
					return detail === "previous_revoked" ? `${actor} đã xoay secret của ${hook} và thu hồi URL cũ ngay` : `${actor} đã xoay secret của ${hook}`;
				case "previous_secret_revoked":
					return `${actor} đã thu hồi secret cũ của ${hook}`;
				case "disabled":
					return detail === "by_moderator" ? `Đội kiểm duyệt đã tắt ${hook}` : `${actor} đã tắt ${hook}`;
				case "enabled":
					return `${actor} đã bật ${hook}`;
				case "auto_disabled":
					return detail === "creator_left" ? `${hook} đã tự tắt: người tạo đã rời chat` : `${hook} đã tự tắt: người tạo không còn là admin`;
				case "taken_over":
					return `${actor} đã nhận lại ${hook}`;
				case "deleted":
					return `${actor} đã xoá ${hook}`;
				case "updated":
					return `${actor} đã sửa ${hook}`;
				case "unknown":
					return `${actor} đã thay đổi ${hook}`;
			}
		},
		/** An "updated" entry with what changed (see parseHookChanges); `hook` is the new name. */
		updated: (actor: string, hook: string, changes: HookChanges): string => {
			const parts: string[] = [];
			if (changes.renamedFrom !== null) parts.push(`đổi tên “${changes.renamedFrom}” thành “${hook}”`);
			if (changes.allowAlert !== null) parts.push(changes.allowAlert ? "cho phép tin Cảnh báo" : "bỏ cho phép tin Cảnh báo");
			if (changes.silent !== null) parts.push(changes.silent ? "bật gửi im lặng" : "tắt gửi im lặng");
			return parts.length === 0 ? `${actor} đã sửa ${hook}` : `${actor} đã sửa ${hook}: ${parts.join(", ")}`;
		},
	},
	time: {
		/** Grace countdown: "6 ngày 23:47:58", or "23:47:58" under a day. */
		countdown: (days: number, clock: string) => (days > 0 ? `${days} ngày ${clock}` : clock),
		days: (n: number) => `${n} ngày`,
		hours: (n: number) => `${n} giờ`,
	},
	notAvailable: "Chỉ admin của nhóm hoặc kênh quản lý được webhook.",
};

export type HooksCopy = typeof viHooks;
