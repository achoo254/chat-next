// Simplified Chinese copy of the incoming webhook screens; keys mirror copy-vi.ts.
import type { HooksCopy } from "./copy-vi.ts";

const kind = (channel: boolean): string => (channel ? "频道" : "群组");

export const zhCNHooks: HooksCopy = {
	title: (channel) => `此${kind(channel)}的 Webhook`,
	crumb: "Webhook",
	backToAdmin: (channel) => `返回${kind(channel)}管理`,
	backToList: "返回 Webhook 列表",
	create: "创建 Webhook",
	creating: "正在创建…",
	manage: "管理",
	manageName: (name) => `管理 Webhook ${name}`,
	columns: { hook: "Webhook", format: "格式", creator: "创建者", lastUsed: "最近接收", state: "状态", actions: "操作" },
	neverUsed: "从未",
	emptyTitle: "还没有 Webhook",
	emptyBody: (channel) =>
		`Webhook 让监控、CI/CD 或脚本通过一个秘密 URL 向此${kind(channel)}发送消息。这些消息会带有“集成：<name>”标签。`,
	membersNote: (channel) => `${channel ? "订阅者" : "普通成员"}会在聊天中看到集成消息，但看不到此列表。`,
	limitReached: (max) => `此聊天已有 ${max} 个 Webhook，达到上限。删除一个不再使用的 Webhook 后才能再添加。`,
	state: {
		active: "已启用",
		disabled: "已关闭",
		auto_disabled: "已自动关闭",
		rotating: "正在轮换密钥",
	},
	stateSub: {
		creatorNotAdmin: "其创建者已不再是管理员",
		creatorLeft: (channel) => `其创建者已离开${kind(channel)}`,
		byModerator: "已被内容审核团队关闭",
		byAdmin: "已被管理员关闭",
		silent: "静默发送",
		oldUrl: (left) => `旧 URL 将在 ${left} 后过期`,
	},
	formats: {
		native: { name: "原生 JSON", note: "text、按钮、group_key、idempotency_key。适用于脚本和 Jenkins。" },
		slack: { name: "Slack 兼容", note: "Grafana、Uptime Kuma，以及通过 Mattermost 集成的 GitLab。支持 mrkdwn。" },
		alertmanager: { name: "Alertmanager", note: "groupKey 相同的告警会原地更新，从 firing 变为 resolved。" },
		grafana: { name: "Grafana", note: "Webhook 联络点：与 Alertmanager 一样原地更新，并带有 Dashboard 和 Panel 按钮。" },
		gitlab: { name: "GitLab", note: "项目 Webhook：push、merge request、pipeline、deployment、issue、release。" },
	},
	form: {
		name: "名称",
		nameHint: "聊天中的人会在“集成：<name>”标签中看到此名称。Webhook 无法冒充用户。",
		nameRequired: "请输入 Webhook 名称",
		nameTooLong: (max) => `名称最多 ${max} 个字符`,
		format: "格式",
		formatHint: "格式决定 URL 后缀以及如何解析请求内容 (payload)。",
		allowAlert: "允许告警优先级",
		allowAlertNote: "priority 为“alert”的请求内容会走最快的推送通道。关闭后，此 Webhook 的所有消息均为普通优先级。",
		silent: "静默发送",
		silentNote: "消息会进入聊天，但不会发出声音或通知。",
		previewTitle: "消息将显示为",
		previewText: "lab-174 CPU 占用过高",
		previewNote: "任何拥有该 URL 的人都能向此聊天发送消息，因此 URL 只在创建后立即显示一次。",
		limit: (max) => `每个聊天最多可有 ${max} 个 Webhook。`,
		invalid: "服务器不接受此名称或格式。请检查后重试。",
	},
	oneTime: {
		createdTitle: (name) => `已创建 Webhook ${name}`,
		rotatedTitle: (name) => `${name} 的新 URL`,
		warn: (chat) => `URL 只显示一次。请立即将其保存到安全的地方；任何拥有它的人都能向 ${chat} 发送消息。`,
		urlLabel: (format) => `Webhook URL（${format}）`,
		copyUrl: "复制 URL",
		urlCopied: "URL 已复制",
		tryNow: "立即试用",
		copyCommand: "复制命令",
		commandCopied: "命令已复制",
		greeting: (name) => `来自 ${name} 的问候`,
		response: (body) => `响应：${body}`,
		saved: "我已保存 URL",
		savedFirst: "关闭前请先勾选“我已保存 URL”",
		done: "完成",
		hidden: "URL 现已隐藏，只保留名称和状态",
	},
	detail: {
		gone: "此 Webhook 已不存在，可能已被其他管理员删除。",
		info: "Webhook",
		format: "格式",
		createdBy: "创建者",
		createdLine: (name, when) => `${name} · ${when}`,
		lastUsed: "最近接收",
		silent: "静默发送",
		allowAlert: "告警优先级",
		on: "开",
		off: "关",
		allowed: "允许",
		notAllowed: "不允许",
		receiving: "接收消息",
		receivingNote: "关闭后，发往该 URL 的请求会被拒绝；URL 保持不变。",
		turnedOn: (name) => `已开启 ${name}`,
		turnedOff: (name) => `已关闭 ${name}，发往其 URL 的请求会被拒绝`,
		creatorNotAdmin: "其创建者已不再是管理员。接管此 Webhook 即可重新开启。",
		autoDisabledBanner: (creator, when, left, channel) =>
			`此 Webhook 已自动关闭，因为 ${creator} ${left ? `已离开${kind(channel)}` : `已不再是${kind(channel)}管理员`}（${when}）。发往其 URL 的请求会被拒绝。`,
		disabledBanner: (when) => `此 Webhook 自 ${when} 起已关闭。重新开启前，发往其 URL 的请求会被拒绝。`,
		moderatorBanner: (when) => `内容审核团队已于 ${when} 关闭此 Webhook。管理员无法重新开启或接管它。`,
		takeOver: "接管 Webhook",
		takeOverNote: "你将成为它的创建者；Webhook 会立即按原有格式和设置重新运行。",
		rotateOnTakeOver: "接管时轮换密钥",
		rotateOnTakeOverNote: (creator) =>
			`默认关闭，以免告警中断。如果不希望 ${creator} 继续使用旧 URL，请开启此项；新 URL 只显示一次。`,
		takenOver: "已接管 Webhook，URL 保持不变",
		takenOverRotated: "已接管 Webhook 并生成新 URL",
		secretTitle: "URL 和密钥",
		secretNote: "服务器只保存密钥的哈希值，因此完整 URL 只在创建、轮换密钥或接管并轮换时显示。",
		currentSecret: "当前密钥",
		currentSecretSub: (when, by) => `由 ${by} 于 ${when} 签发`,
		accepting: "接受中",
		refused: "已拒绝",
		previousSecret: "旧密钥",
		previousSecretSub: "宽限期内仍被接受",
		expiresIn: "过期剩余",
		graceProgress: "宽限期已过",
		rotate: "轮换密钥",
		revokePrevious: "立即撤销旧密钥",
		revokedPrevious: "已撤销旧密钥；只有新 URL 有效",
		noPrevious: "旧密钥已过期或已被撤销",
		statsTitle: "计数",
		window: "时间段",
		windows: { day: "24 小时", week: "7 天", month: "30 天" },
		accepted: "已接收",
		acceptedSub: "已接受的请求",
		delivered: "实时送达",
		deliveredSub: "送达至少一个在线会话",
		failed: "失败",
		failedSub: "未生成消息",
		noPerMember: "不跟踪每位成员的送达情况，只统计这些总数。要查看谁读过某条消息，请在该消息上使用“已读”（限小型群组）。",
		failureColumns: { reason: "失败原因", count: "次数", last: "最近一次" },
		noFailures: "此时间段内没有失败。",
		deadTitle: "失败的请求",
		deadNote: "无法处理的请求，保留 30 天，最新的在前。请求正文最多保留 16 KiB。",
		deadEmpty: "没有失败的请求。",
		deadStatus: (status) => `HTTP ${status}`,
		deadContentType: (type) => `Content-Type: ${type === "" ? "（无）" : type}`,
		deadBody: "正文",
		deadEmptyBody: "（空正文）",
		deadTruncated: "正文超过 16 KiB，其余部分已截断。",
		more: "显示更多",
		guideTitle: "如何连接",
		copySnippet: "复制配置",
		snippetCopied: "配置已复制",
		guideUrl: "{URL} 是你创建 Webhook 时保存的 URL，已包含格式后缀。",
		dangerTitle: "删除 Webhook",
		dangerNote: "URL 会立即失效。已发送的消息仍保留在聊天中；日志也会保留。",
		delete: "删除 Webhook",
	},
	failures: {
		rate_limited: "超出速率限制",
		payload_too_large: "请求内容超过 64 KB",
		invalid_json: "JSON 格式错误",
		invalid_payload: "请求内容与所选格式不符",
		text_empty: "没有内容",
		text_too_long: "文本超过 4096 个字符",
		url_not_allowed: "链接使用了不允许的协议",
		hook_disabled: "Webhook 已关闭",
		chat_unavailable: "聊天已不存在",
		internal: "服务器错误",
	},
	guides: {
		native: [
			"创建一个原生 JSON 格式的 Webhook；如果只用来报告构建成功，请开启“静默发送”。",
			"将 URL 保存到 Jenkins Credentials（Secret text），id 设为 chat-hook-url。",
			"添加一个调用 curl 的 post 步骤；idempotency_key 可防止 Jenkins 重试时重复发送。",
		],
		slack: [
			"Grafana：Alerting → Contact points → Add contact point，选择 Slack 集成，并将 URL 粘贴到 Webhook URL。",
			"GitLab：Settings → Integrations → Mattermost notifications，将 URL 粘贴到 Webhook（GitLab 会拦截 Discord URL；新版 Slack 集成需要安装应用）。",
			"Uptime Kuma：Settings → Notifications → Setup Notification，选择 Slack 并按示例粘贴 URL。",
		],
		alertmanager: [
			"添加一个指向该 URL 的 webhook_configs 接收器，并开启 send_resolved。",
			"重新加载 Alertmanager。groupKey 相同的告警会原地编辑同一条消息，而不是发送新消息。",
		],
		grafana: [
			"Grafana：Alerting → Contact points → Add contact point，选择 Webhook 集成。",
			"粘贴 URL，方法选 POST，点击 Test：Webhook 的消息会出现在聊天中。",
			"同一组的告警会原地编辑同一条消息，从 firing 变为 resolved。",
		],
		gitlab: [
			"GitLab：Settings → Webhooks → Add new webhook。",
			"粘贴 URL，选择事件（push、merge request、pipeline、deployment），保持 SSL verification 开启。",
			"点击 Test → Push events：Webhook 的消息会出现在聊天中。Merge request 和 pipeline 会原地更新。",
		],
	},
	rotateDialog: {
		title: (name) => `轮换 ${name} 的密钥？`,
		note: "将生成一个新 URL，只显示一次。旧 URL 会继续有效 7 天，方便你更新工具配置。",
		revokeNow: "立即撤销旧 URL",
		revokeNowNote: "适用于 URL 已泄露的情况：发往旧 URL 的请求会立即被拒绝。",
		confirm: "轮换密钥",
	},
	deleteDialog: {
		title: (name) => `删除 Webhook ${name}？`,
		note: "URL 会立即失效且无法恢复。已发送的消息仍保留在聊天中；日志也会保留。",
		confirm: "删除 Webhook",
		deleted: (name) => `已删除 Webhook ${name}`,
	},
	editDialog: {
		open: "编辑设置",
		title: (name) => `编辑 Webhook ${name}`,
		nameHint: "新名称会以“集成：<name>”标签显示在之后的消息上；已发送的消息保留旧名称。",
		formatNote: (format) => `${format} 格式是 URL 的一部分，因此无法更改。如需其他格式，请另建一个 Webhook。`,
		save: "保存",
		saving: "正在保存…",
		saved: (name) => `已保存 ${name} 的设置`,
	},
	audit: {
		title: "日志",
		chatNote: "此聊天中 Webhook 的所有变更，包括已删除的 Webhook。",
		empty: "还没有任何变更。",
		server: "系统",
		action: (action, actor, hook, detail) => {
			switch (action) {
				case "created":
					return `${actor} 创建了 ${hook}`;
				case "secret_rotated":
					return detail === "previous_revoked" ? `${actor} 轮换了 ${hook} 的密钥并立即撤销了旧 URL` : `${actor} 轮换了 ${hook} 的密钥`;
				case "previous_secret_revoked":
					return `${actor} 撤销了 ${hook} 的旧密钥`;
				case "disabled":
					return detail === "by_moderator" ? `内容审核团队关闭了 ${hook}` : `${actor} 关闭了 ${hook}`;
				case "enabled":
					return `${actor} 开启了 ${hook}`;
				case "auto_disabled":
					return detail === "creator_left" ? `${hook} 已自动关闭：其创建者已离开聊天` : `${hook} 已自动关闭：其创建者已不再是管理员`;
				case "taken_over":
					return `${actor} 接管了 ${hook}`;
				case "deleted":
					return `${actor} 删除了 ${hook}`;
				case "updated":
					return `${actor} 编辑了 ${hook}`;
				case "unknown":
					return `${actor} 更改了 ${hook}`;
			}
		},
		updated: (actor, hook, changes) => {
			const parts: string[] = [];
			if (changes.renamedFrom !== null) parts.push(`将“${changes.renamedFrom}”重命名为“${hook}”`);
			if (changes.allowAlert !== null) parts.push(changes.allowAlert ? "允许告警优先级" : "不再允许告警优先级");
			if (changes.silent !== null) parts.push(changes.silent ? "开启静默发送" : "关闭静默发送");
			return parts.length === 0 ? `${actor} 编辑了 ${hook}` : `${actor} 编辑了 ${hook}：${parts.join("，")}`;
		},
	},
	time: {
		countdown: (days, clock) => (days > 0 ? `${days} 天 ${clock}` : clock),
		days: (n) => `${n} 天`,
		hours: (n) => `${n} 小时`,
	},
	notAvailable: "只有群组或频道的管理员才能管理 Webhook。",
};
