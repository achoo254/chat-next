// Copy of the Live Map's drawer, event detail and replay bar in the three UI
// languages. It ships with the Live Map's own chunk (all three are small), so
// nothing is fetched on first use. Station names stay in copy-*.ts
// (`observe.stations`).
import { useI18n, type Locale } from "../../i18n/i18n.tsx";

export interface ObservatoryCopy {
	/** For Intl formatting of times and numbers. */
	readonly locale: string;
	readonly close: string;
	readonly drawer: {
		readonly label: (station: string) => string;
		readonly scopeLive: (start: string) => string;
		readonly scopeReplay: (at: string) => string;
		readonly loading: string;
		readonly calls: string;
		readonly latency: string;
		readonly sampled: string;
		readonly errorRate: string;
		readonly tokens: string;
		readonly tokenParts: (input: string, output: string, cache: string) => string;
		readonly cost: string;
		readonly noCost: string;
		readonly costNote: string;
		readonly withoutCost: (n: number) => string;
		readonly parts: Readonly<Record<string, string>>;
		readonly partsOther: string;
		readonly hiddenPart: (n: number) => string;
		readonly partLine: (calls: string, p95: string) => string;
		readonly previous: string;
		readonly previousOver: (n: number) => string;
		readonly previousNone: string;
		readonly compareP95: string;
		readonly compareErrors: string;
		readonly compareTokens: string;
		readonly compareNone: string;
		readonly slowest: string;
		readonly recent: string;
		readonly noEvents: string;
		readonly findings: string;
		readonly noFindings: string;
		readonly open: string;
		readonly closed: string;
		readonly evidence: (n: number) => string;
		readonly finding: (rule: string, value: string, threshold: string) => string;
		readonly findingN: (n: number) => string;
	};
	readonly rules: {
		readonly tool_slow: string;
		readonly api_slow: string;
		readonly api_limited: string;
		readonly repeat_read: string;
		readonly context_high: string;
		readonly mcp_errors: string;
		readonly subagent_idle: string;
		readonly cost_spike: string;
		readonly unknown: string;
	};
	readonly severity: { readonly warn: string; readonly alert: string };
	readonly units: { readonly perToken: string; readonly perMinute: string; readonly reads: string; readonly limited: string };
	readonly detail: {
		readonly label: string;
		readonly kinds: Readonly<Record<"prompt" | "tool" | "subagent" | "api" | "instruction" | "git" | "lifecycle" | "bottleneck", string>>;
		readonly kind: string;
		readonly station: string;
		readonly estimated: string;
		readonly time: string;
		readonly duration: string;
		readonly result: string;
		readonly running: string;
		readonly ok: string;
		readonly failed: string;
		readonly ended: string;
		readonly provisional: string;
		readonly labels: string;
		readonly model: string;
		readonly tokens: string;
		readonly tokenLine: (output: string, context: string | null) => string;
		readonly content: string;
		readonly contentLoading: string;
		readonly contentOff: string;
		readonly contentNone: string;
		readonly contentNotYet: string;
		readonly hidden: string;
		readonly replayHere: string;
	};
	readonly replay: {
		readonly label: string;
		readonly title: string;
		readonly play: string;
		readonly pause: string;
		readonly live: string;
		readonly speed: (n: number) => string;
		readonly previous: string;
		readonly next: string;
		readonly slider: string;
		readonly position: (at: string, end: string) => string;
		readonly silence: string;
		readonly keys: string;
		readonly loading: string;
		readonly expired: string;
		readonly partial: (start: string) => string;
		readonly held: (n: number) => string;
	};
}

const vi: ObservatoryCopy = {
	locale: "vi-VN",
	close: "Đóng",
	drawer: {
		label: (station) => `Khoan sâu: ${station}`,
		scopeLive: (start) => `Phiên này · từ ${start} đến nay`,
		scopeReplay: (at) => `Phiên này · đến mốc tua ${at}`,
		loading: "Đang tải số của trạm…",
		calls: "Số lần gọi",
		latency: "p50 / p95",
		sampled: "lấy mẫu",
		errorRate: "Tỷ lệ lỗi",
		tokens: "Token",
		tokenParts: (input, output, cache) => `vào ${input} · ra ${output} · cache ${cache}`,
		cost: "Chi phí ước tính",
		noCost: "không có chi phí",
		costNote: "* ước tính của Claude Code theo giá API",
		withoutCost: (n) => `${n} lượt API không có ước tính`,
		parts: { mcp_server: "Theo server", file: "Theo tệp", domain: "Theo tên miền", program: "Theo chương trình", tool: "Theo tool", model: "Theo model" },
		partsOther: "Theo khoá con",
		hiddenPart: (n) => `Mục ${n}`,
		partLine: (calls, p95) => `${calls} · ${p95}`,
		previous: "So với 5 phiên trước",
		previousOver: (n) => `trung bình ${n} phiên trước cùng repo`,
		previousNone: "Chưa có phiên trước cùng repo để so.",
		compareP95: "Thời gian p95",
		compareErrors: "Tỷ lệ lỗi",
		compareTokens: "Token mỗi lượt API",
		compareNone: "chưa đủ số",
		slowest: "Chậm nhất",
		recent: "Sự kiện gần đây",
		noEvents: "Chưa có sự kiện.",
		findings: "Điểm nghẽn",
		noFindings: "Không có điểm nghẽn ở trạm này trong phiên.",
		open: "đang mở",
		closed: "đã đóng",
		evidence: (n) => `Bằng chứng ${n}`,
		finding: (rule, value, threshold) => `${rule}: ${value} so với ngưỡng ${threshold}`,
		findingN: (n) => `n = ${n}`,
	},
	rules: {
		tool_slow: "Tool chậm hơn p95 của chính nó",
		api_slow: "API chậm",
		api_limited: "API bị giới hạn tốc độ (429)",
		repeat_read: "Đọc lặp một tệp",
		context_high: "Ngữ cảnh gần đầy",
		mcp_errors: "MCP lỗi nhiều",
		subagent_idle: "Subagent chạy lâu mà ít việc",
		cost_spike: "Lượt tốn bất thường",
		unknown: "Điểm nghẽn",
	},
	severity: { warn: "cảnh báo", alert: "nghiêm trọng" },
	units: { perToken: "ms/token", perMinute: "token/phút", reads: "lần đọc", limited: "lượt bị chặn" },
	detail: {
		label: "Chi tiết sự kiện",
		kinds: { prompt: "Prompt", tool: "Gọi tool", subagent: "Subagent", api: "Lượt API", instruction: "Nạp hướng dẫn", git: "Git", lifecycle: "Sự kiện phiên", bottleneck: "Điểm nghẽn" },
		kind: "Loại",
		station: "Trạm",
		estimated: "ước lượng",
		time: "Giờ",
		duration: "Thời lượng",
		result: "Kết quả",
		running: "đang chạy",
		ok: "xong",
		failed: "lỗi",
		ended: "đã dừng",
		provisional: "tạm, máy chưa lưu",
		labels: "Nhãn",
		model: "Model",
		tokens: "Token",
		tokenLine: (output, context) => (context === null ? `ra ${output}` : `ra ${output} · ngữ cảnh ${context}`),
		content: "Nội dung",
		contentLoading: "Đang xin nội dung từ máy…",
		contentOff: "Dự án này tắt lưu nội dung nên không có nội dung để xem.",
		contentNone: "Sự kiện này không có nội dung được lưu.",
		contentNotYet: "Sự kiện còn tạm, máy chưa lưu nên chưa có nội dung. Mở lại sau ít giây.",
		hidden: "Đang bật Ẩn chi tiết: nhãn và nội dung được giấu.",
		replayHere: "Tua tới đây",
	},
	replay: {
		label: "Thanh thời gian của phiên",
		title: "Tua lại",
		play: "Phát",
		pause: "Tạm dừng",
		live: "Trực tiếp",
		speed: (n) => `Tốc độ ${n}×`,
		previous: "Sự kiện trước",
		next: "Sự kiện sau",
		slider: "Mốc tua",
		position: (at, end) => `${at} / ${end}`,
		silence: "Khoảng lặng quá 10 giây phát trong 1 giây.",
		keys: "Space: phát hoặc dừng · ←/→: sự kiện trước, sau",
		loading: "Đang nạp các sự kiện cũ…",
		expired: "Chi tiết đã quá 90 ngày, chỉ còn số tổng hợp.",
		partial: (start) => `Chỉ tua được từ ${start}: giữ tối đa 20 000 sự kiện.`,
		held: (n) => `${n} sự kiện mới đang chờ`,
	},
};

const en: ObservatoryCopy = {
	locale: "en-US",
	close: "Close",
	drawer: {
		label: (station) => `Drill-down: ${station}`,
		scopeLive: (start) => `This session · from ${start} until now`,
		scopeReplay: (at) => `This session · up to the replayed moment ${at}`,
		loading: "Loading the station's numbers…",
		calls: "Calls",
		latency: "p50 / p95",
		sampled: "sampled",
		errorRate: "Error rate",
		tokens: "Tokens",
		tokenParts: (input, output, cache) => `in ${input} · out ${output} · cache ${cache}`,
		cost: "Estimated cost",
		noCost: "no cost",
		costNote: "* Claude Code's estimate at API prices",
		withoutCost: (n) => `${n} API requests without an estimate`,
		parts: { mcp_server: "By server", file: "By file", domain: "By domain", program: "By program", tool: "By tool", model: "By model" },
		partsOther: "By sub-key",
		hiddenPart: (n) => `Item ${n}`,
		partLine: (calls, p95) => `${calls} · ${p95}`,
		previous: "Compared with the 5 previous sessions",
		previousOver: (n) => `average of ${n} previous sessions of this repository`,
		previousNone: "No previous session of this repository to compare with.",
		compareP95: "p95 time",
		compareErrors: "Error rate",
		compareTokens: "Tokens per API request",
		compareNone: "not enough data",
		slowest: "Slowest",
		recent: "Recent events",
		noEvents: "No events yet.",
		findings: "Bottlenecks",
		noFindings: "No bottleneck at this station in this session.",
		open: "open",
		closed: "closed",
		evidence: (n) => `Evidence ${n}`,
		finding: (rule, value, threshold) => `${rule}: ${value} against a threshold of ${threshold}`,
		findingN: (n) => `n = ${n}`,
	},
	rules: {
		tool_slow: "Tool slower than its own p95",
		api_slow: "Slow API",
		api_limited: "API rate limited (429)",
		repeat_read: "Same file read again and again",
		context_high: "Context nearly full",
		mcp_errors: "MCP failing often",
		subagent_idle: "Subagent running long with little work",
		cost_spike: "Unusually costly turn",
		unknown: "Bottleneck",
	},
	severity: { warn: "warning", alert: "critical" },
	units: { perToken: "ms/token", perMinute: "tokens/min", reads: "reads", limited: "limited requests" },
	detail: {
		label: "Event detail",
		kinds: { prompt: "Prompt", tool: "Tool call", subagent: "Subagent", api: "API request", instruction: "Instructions loaded", git: "Git", lifecycle: "Session event", bottleneck: "Bottleneck" },
		kind: "Kind",
		station: "Station",
		estimated: "estimated",
		time: "Time",
		duration: "Duration",
		result: "Result",
		running: "running",
		ok: "done",
		failed: "failed",
		ended: "stopped",
		provisional: "provisional, not stored yet",
		labels: "Labels",
		model: "Model",
		tokens: "Tokens",
		tokenLine: (output, context) => (context === null ? `out ${output}` : `out ${output} · context ${context}`),
		content: "Content",
		contentLoading: "Asking the machine for the content…",
		contentOff: "This project does not store content, so there is nothing to show.",
		contentNone: "This event has no stored content.",
		contentNotYet: "This event is provisional and not stored yet, so it has no content. Open it again in a few seconds.",
		hidden: "Hide details is on: labels and content are hidden.",
		replayHere: "Replay to here",
	},
	replay: {
		label: "Session timeline",
		title: "Replay",
		play: "Play",
		pause: "Pause",
		live: "Live",
		speed: (n) => `Speed ${n}×`,
		previous: "Previous event",
		next: "Next event",
		slider: "Replayed moment",
		position: (at, end) => `${at} / ${end}`,
		silence: "Silences longer than 10 seconds play in 1 second.",
		keys: "Space: play or pause · ←/→: previous, next event",
		loading: "Loading older events…",
		expired: "Details are older than 90 days; only the totals remain.",
		partial: (start) => `Replay starts at ${start}: at most 20,000 events are kept.`,
		held: (n) => `${n} new events waiting`,
	},
};

const zhCN: ObservatoryCopy = {
	locale: "zh-CN",
	close: "关闭",
	drawer: {
		label: (station) => `深入查看：${station}`,
		scopeLive: (start) => `本会话 · 从 ${start} 至今`,
		scopeReplay: (at) => `本会话 · 截至回放时刻 ${at}`,
		loading: "正在加载该站点的数据…",
		calls: "调用次数",
		latency: "p50 / p95",
		sampled: "抽样",
		errorRate: "错误率",
		tokens: "Token",
		tokenParts: (input, output, cache) => `输入 ${input} · 输出 ${output} · 缓存 ${cache}`,
		cost: "估算费用",
		noCost: "无费用数据",
		costNote: "* Claude Code 按 API 价格的估算",
		withoutCost: (n) => `${n} 次 API 请求没有估算`,
		parts: { mcp_server: "按服务器", file: "按文件", domain: "按域名", program: "按程序", tool: "按工具", model: "按模型" },
		partsOther: "按子键",
		hiddenPart: (n) => `项目 ${n}`,
		partLine: (calls, p95) => `${calls} · ${p95}`,
		previous: "与前 5 个会话相比",
		previousOver: (n) => `同一仓库前 ${n} 个会话的平均值`,
		previousNone: "同一仓库还没有可比较的会话。",
		compareP95: "p95 耗时",
		compareErrors: "错误率",
		compareTokens: "每次 API 请求的 Token",
		compareNone: "数据不足",
		slowest: "最慢",
		recent: "最近事件",
		noEvents: "还没有事件。",
		findings: "瓶颈",
		noFindings: "本会话中该站点没有瓶颈。",
		open: "未关闭",
		closed: "已关闭",
		evidence: (n) => `证据 ${n}`,
		finding: (rule, value, threshold) => `${rule}：${value}，阈值 ${threshold}`,
		findingN: (n) => `n = ${n}`,
	},
	rules: {
		tool_slow: "工具慢于自身 p95",
		api_slow: "API 缓慢",
		api_limited: "API 被限速（429）",
		repeat_read: "反复读取同一文件",
		context_high: "上下文接近满",
		mcp_errors: "MCP 频繁出错",
		subagent_idle: "子代理运行很久但工作很少",
		cost_spike: "本轮花费异常",
		unknown: "瓶颈",
	},
	severity: { warn: "警告", alert: "严重" },
	units: { perToken: "毫秒/token", perMinute: "token/分钟", reads: "次读取", limited: "次被限速" },
	detail: {
		label: "事件详情",
		kinds: { prompt: "提示", tool: "工具调用", subagent: "子代理", api: "API 请求", instruction: "加载指令", git: "Git", lifecycle: "会话事件", bottleneck: "瓶颈" },
		kind: "类型",
		station: "站点",
		estimated: "估计",
		time: "时间",
		duration: "耗时",
		result: "结果",
		running: "运行中",
		ok: "完成",
		failed: "失败",
		ended: "已停止",
		provisional: "临时，机器尚未保存",
		labels: "标签",
		model: "模型",
		tokens: "Token",
		tokenLine: (output, context) => (context === null ? `输出 ${output}` : `输出 ${output} · 上下文 ${context}`),
		content: "内容",
		contentLoading: "正在向机器请求内容…",
		contentOff: "此项目关闭了内容保存，没有可查看的内容。",
		contentNone: "此事件没有保存的内容。",
		contentNotYet: "此事件仍是临时的，机器尚未保存，因此还没有内容。请几秒后再打开。",
		hidden: "已开启「隐藏详情」：标签和内容被隐藏。",
		replayHere: "回放到这里",
	},
	replay: {
		label: "会话时间轴",
		title: "回放",
		play: "播放",
		pause: "暂停",
		live: "实时",
		speed: (n) => `速度 ${n}×`,
		previous: "上一个事件",
		next: "下一个事件",
		slider: "回放时刻",
		position: (at, end) => `${at} / ${end}`,
		silence: "超过 10 秒的空闲以 1 秒播放。",
		keys: "空格：播放或暂停 · ←/→：上一个、下一个事件",
		loading: "正在加载更早的事件…",
		expired: "详情已超过 90 天，只剩汇总数据。",
		partial: (start) => `只能从 ${start} 开始回放：最多保留 20,000 个事件。`,
		held: (n) => `${n} 个新事件等待中`,
	},
};

export const OBSERVATORY_COPY: Readonly<Record<Locale, ObservatoryCopy>> = { vi, en, "zh-CN": zhCN };

/** The Live Map's drawer, detail and replay copy in the UI language. */
export function useObservatoryCopy(): ObservatoryCopy {
	return OBSERVATORY_COPY[useI18n().locale];
}
