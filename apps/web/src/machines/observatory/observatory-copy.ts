// Copy of the Live Map (the activity card, the scene, the column beside it,
// the event list, the legend) in the three UI languages. It ships with the
// Live Map's own chunk (all three are small), so nothing is fetched on first
// use. Station names stay in copy-*.ts (`observe.stations`).
import { useI18n, type Locale } from "../../i18n/i18n.tsx";

type PlaceKey = "core" | "user-desk" | "orchestrator" | "memory" | "skills" | "files" | "mcp" | "external" | "security" | "sandbox" | "testing" | "git" | "monitoring";

/** A token count the way the reservoir shows it: "820", "184k", "1M". */
function tokenSize(n: number): string {
	if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

export interface ObservatoryCopy {
	/** For Intl formatting of times and numbers. */
	readonly locale: string;
	readonly close: string;
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
	readonly detail: {
		readonly kinds: Readonly<Record<"prompt" | "tool" | "subagent" | "api" | "instruction" | "git" | "lifecycle" | "bottleneck", string>>;
	};
	/** The activity card over the scene (activity-card.tsx). */
	readonly card: {
		readonly label: string;
		readonly status: Readonly<Record<"run" | "ok" | "err" | "wait" | "think" | "idle", string>>;
		readonly running: string;
		readonly done: string;
		readonly failed: string;
		readonly waitKind: string;
		readonly thinkKind: (turn: number) => string;
		readonly idleKind: string;
		readonly steps: Readonly<Record<"commit" | "push" | "ci" | "deploy", string>>;
		readonly subagent: (type: string) => string;
		/** A subagent whose type is not known. */
		readonly subagentUnknown: string;
		readonly runtime: string;
		readonly waited: string;
		readonly p95: string;
		readonly calls: string;
		readonly noHistory: string;
		readonly historyCount: (n: number) => string;
		readonly overP95: string;
		readonly thinking: string;
		readonly waitWhat: (what: string) => string;
		readonly waitDesc: string;
		readonly idleWhat: string;
		readonly lastJob: (what: string, ok: boolean, runtime: string) => string;
		readonly output: string;
		readonly outputPending: string;
		readonly outputEmpty: string;
		readonly outputHidden: string;
		readonly outputOff: string;
		readonly outputNone: string;
		readonly outputNotYet: string;
		readonly outputLoading: string;
		readonly outputFailed: string;
		readonly outputUnavailable: string;
		readonly journey: string;
		readonly more: string;
	};
	/** The camera's modes and the note under them. */
	readonly camera: {
		readonly label: string;
		readonly auto: string;
		readonly free: string;
		readonly focus: string;
		readonly whole: string;
		readonly note: (where: string, n: number, events: number) => string;
	};
	/** The words drawn inside the machine's scene (render/interior-painter.ts). */
	readonly scene: {
		/** Each module's name tag. */
		readonly tags: Readonly<Record<PlaceKey, string>>;
		/** The line under each module's name. */
		readonly subs: Readonly<Record<PlaceKey, string>>;
		readonly calls: (n: number) => string;
		readonly p95: (d: string) => string;
		readonly failures: (n: number) => string;
		readonly runtime: (d: string) => string;
		readonly noCalls: string;
		readonly modelTitle: (model: string) => string;
		readonly thinking: string;
		readonly waiting: string;
		readonly executing: string;
		readonly idle: string;
		readonly apiLine: (turn: number, kTokens: number, tps: number) => string;
		/** The reservoir's line: percent (null: unknown), tokens used and the window. */
		readonly contextLine: (percent: number | null, tokens: number, window: number) => string;
		readonly wave: (tps: number) => string;
		readonly portal: string;
		readonly subagent: (type: string) => string;
		/** A subagent whose type is not known. */
		readonly subagentShort: string;
		/** An MCP tool's name while "Ẩn chi tiết" is on. */
		readonly mcpTool: string;
		/** An MCP server's name while "Ẩn chi tiết" is on. */
		readonly mcpServer: (n: number) => string;
		readonly noMcp: string;
		readonly moreServers: (n: number) => string;
		readonly steps: Readonly<Record<"commit" | "push" | "ci" | "deploy", string>>;
		readonly stepFailed: string;
		/** A CI step whose outcome is not known (the machine stopped following it, or it ran too long without news). */
		readonly stepUnknown: string;
		readonly prod: string;
	};
	/** The column beside the scene: the session's gauges and the detail (live-map-side.tsx). */
	readonly side: {
		readonly session: string;
		readonly context: string;
		readonly speed: string;
		readonly tokPerSec: string;
		readonly tools: string;
		readonly subagents: string;
		readonly detail: string;
		readonly detailHint: string;
		readonly status: string;
		readonly running: string;
		readonly ok: string;
		readonly failed: string;
		readonly runtimeNow: string;
		readonly p95Place: string;
		readonly none: string;
		readonly callsPlace: string;
		readonly target: string;
		readonly agent: string;
		readonly mainAgent: string;
		readonly description: string;
		readonly output: string;
		readonly outputRunning: string;
		readonly contentNote: string;
		readonly kind: string;
		readonly time: string;
		readonly label: string;
		readonly doing: string;
		readonly modes: Readonly<Record<"think" | "exec" | "wait" | "idle", string>>;
		readonly apiTurns: string;
		readonly speedRow: string;
		readonly subagentRow: string;
		readonly used: string;
		readonly ratio: string;
		readonly noCallsYet: string;
		readonly p50p95: string;
		readonly errors: string;
		readonly recent: string;
		readonly stepRow: (step: string, n: number, p95: string) => string;
		readonly stepState: Readonly<Record<"idle" | "run" | "ok" | "err" | "unknown", string>>;
		readonly waitingFor: string;
		readonly prompts: string;
	};
	/** The event list beside the scene (event-feed.tsx). */
	readonly feed: {
		readonly title: string;
		readonly running: string;
		readonly failed: (d: string) => string;
		readonly prompt: string;
		readonly api: (turn: number, tokens: string) => string;
		readonly subStart: (type: string) => string;
		readonly subEnd: (type: string) => string;
		readonly instruction: (what: string) => string;
		readonly permAsk: (what: string) => string;
		readonly permOk: (what: string) => string;
		readonly permDenied: (what: string) => string;
		readonly compactStart: string;
		readonly compactEnd: string;
		readonly stop: string;
		readonly stopFailure: string;
		readonly apiError: (code: string) => string;
		readonly bottleneck: (rule: string) => string;
		readonly bottleneckClosed: (rule: string) => string;
		readonly ciStart: (name: string) => string;
		readonly ciEnd: (name: string, ok: boolean | undefined) => string;
		readonly git: (kind: string) => string;
	};
	/** How to read the scene, under it: each paragraph alternates bold and plain parts, bold first. */
	readonly legend: readonly (readonly string[])[];
}

const vi: ObservatoryCopy = {
	locale: "vi-VN",
	close: "Đóng",
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
	detail: {
		kinds: { prompt: "Prompt", tool: "Gọi tool", subagent: "Subagent", api: "Lượt API", instruction: "Nạp hướng dẫn", git: "Git", lifecycle: "Sự kiện phiên", bottleneck: "Điểm nghẽn" },
	},
	card: {
		label: "Hoạt động hiện tại",
		status: { run: "Đang chạy", ok: "Thành công", err: "Lỗi", wait: "Đang chờ", think: "Suy nghĩ", idle: "Rảnh" },
		running: "Đang thực thi",
		done: "Vừa xong",
		failed: "Lỗi",
		waitKind: "Chờ bạn cấp quyền",
		thinkKind: (turn) => `Đang suy nghĩ · lượt API #${turn}`,
		idleKind: "Rảnh",
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		subagent: (type) => `subagent ${type}`,
		subagentUnknown: "subagent",
		runtime: "Runtime",
		waited: "Đã chờ",
		p95: "p95 lịch sử",
		calls: "Lần gọi",
		noHistory: "Lần đầu trong phiên · chưa có lịch sử",
		historyCount: (n) => `(${n} lần trước)`,
		overP95: "lâu hơn p95 lịch sử",
		thinking: "Claude đang suy nghĩ",
		waitWhat: (what) => (what === "" ? "Claude xin quyền" : `Claude xin quyền: ${what}`),
		waitDesc: "Claude dừng lại cho tới khi bạn cho phép.",
		idleWhat: "chờ prompt tiếp theo",
		lastJob: (what, ok, runtime) => `Việc cuối: ${what} · ${ok ? "thành công" : "lỗi"} · runtime ${runtime}`,
		output: "Output",
		outputPending: "chưa có — Claude Code gửi output khi lệnh xong",
		outputEmpty: "(trống)",
		outputHidden: "đang bật Ẩn chi tiết",
		outputOff: "dự án tắt lưu nội dung",
		outputNone: "không có nội dung được lưu",
		outputNotYet: "máy chưa lưu, xem lại sau ít giây",
		outputLoading: "đang xin từ máy…",
		outputFailed: "chưa lấy được từ máy",
		outputUnavailable: "chưa xem được ở đây",
		journey: "Hành trình",
		more: "Xem chi tiết",
	},
	camera: {
		label: "Chế độ camera",
		auto: "Tự động",
		free: "Tự do",
		focus: "Tập trung",
		whole: "toàn cảnh",
		note: (where, n, events) => `góc: ${where} · đổi ${n} lần / ${events} sự kiện`,
	},
	scene: {
		tags: {
			core: "MODEL",
			"user-desk": "NHẬP",
			orchestrator: "SUBAGENT",
			memory: "BỘ NHỚ",
			skills: "KỸ NĂNG",
			files: "KHO TỆP",
			mcp: "CỔNG MCP",
			external: "CỔNG KHÔNG GIAN",
			security: "KHOÁ",
			sandbox: "TERMINAL",
			testing: "KIỂM THỬ",
			git: "GIT · CI/CD",
			monitoring: "BỂ NGỮ CẢNH",
		},
		subs: {
			core: "model",
			"user-desk": "prompt",
			orchestrator: "subagent",
			memory: "CLAUDE.md",
			skills: "skill",
			files: "đọc · sửa · tìm",
			mcp: "máy chủ MCP",
			external: "internet",
			security: "quyền",
			sandbox: "lệnh shell",
			testing: "test",
			git: "đường ống phát hành",
			monitoring: "ngữ cảnh",
		},
		calls: (n) => `${n} lần gọi`,
		p95: (d) => `p95 ls ${d}`,
		failures: (n) => `${n} lỗi`,
		runtime: (d) => `runtime ${d}`,
		noCalls: "chưa có lần gọi nào",
		modelTitle: (model) => (model === "" ? "MODEL" : `MODEL · ${model}`),
		thinking: "SUY NGHĨ",
		waiting: "CHỜ BẠN",
		executing: "đã giao việc, chờ kết quả",
		idle: "rảnh",
		apiLine: (turn, k, tps) => `lượt API #${turn} · ${k}k ngữ cảnh · ${tps} tok/s`,
		contextLine: (percent, tokens, window) => `${percent === null ? "–" : `${percent}%`} · ${tokenSize(tokens)} / ${window > 0 ? tokenSize(window) : "?"}`,
		wave: (tps) => `SÓNG TOKEN · ${tps} tok/s`,
		portal: "CỔNG KHÔNG GIAN · internet",
		subagent: (type) => `subagent · ${type}`,
		subagentShort: "subagent",
		mcpTool: "tool MCP",
		mcpServer: (n) => `máy chủ ${n}`,
		noMcp: "chưa dùng máy chủ MCP nào",
		moreServers: (n) => `+${n} máy chủ khác`,
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		stepFailed: "✗ lỗi",
		stepUnknown: "? không rõ",
		prod: "prod",
	},
	side: {
		session: "Phiên",
		context: "ngữ cảnh",
		speed: "tốc độ",
		tokPerSec: "tok/s",
		tools: "lần gọi tool",
		subagents: "subagent",
		detail: "Chi tiết",
		detailHint: "Bấm \"Xem chi tiết\" trên thẻ hoạt động, bấm một khối, hoặc bấm một dòng sự kiện.",
		status: "Trạng thái",
		running: "đang chạy",
		ok: "thành công",
		failed: "lỗi",
		runtimeNow: "Runtime (lần này)",
		p95Place: "p95 lịch sử của khối",
		none: "chưa có",
		callsPlace: "Lần gọi của khối",
		target: "Đích",
		agent: "Tác nhân",
		mainAgent: "agent chính",
		description: "Mô tả của Claude",
		output: "Output",
		outputRunning: "chưa có (Claude Code gửi output khi lệnh xong)",
		contentNote: "Mô tả và output là nội dung: chỉ hiện khi dự án bật lưu nội dung và Ẩn chi tiết tắt.",
		kind: "Loại",
		time: "Giờ",
		label: "Nhãn",
		doing: "Đang",
		modes: { think: "suy nghĩ", exec: "thực thi (chờ tool)", wait: "chờ bạn", idle: "rảnh" },
		apiTurns: "Lượt API",
		speedRow: "Tốc độ",
		subagentRow: "Subagent",
		used: "Đã dùng",
		ratio: "Tỷ lệ",
		noCallsYet: "Chưa có lần gọi nào trong phiên này.",
		p50p95: "p50 / p95 lịch sử",
		errors: "Lỗi",
		recent: "Gần đây (runtime từng lần)",
		stepRow: (step, n, p95) => `${step} · ${n} lần · p95 ls ${p95}`,
		stepState: { idle: "–", run: "đang chạy", ok: "đạt", err: "lỗi", unknown: "không rõ" },
		waitingFor: "Đang chờ quyền",
		prompts: "Prompt trong phiên",
	},
	feed: {
		title: "Sự kiện",
		running: "chạy…",
		failed: (d) => `lỗi · ${d}`,
		prompt: "prompt",
		api: (turn, tokens) => `suy nghĩ · lượt API #${turn}${tokens === "" ? "" : ` · ${tokens} token ngữ cảnh`}`,
		subStart: (type) => `subagent ${type} bắt đầu`,
		subEnd: (type) => `subagent ${type} xong`,
		instruction: (what) => `nạp ${what}`,
		permAsk: (what) => `chờ bạn cấp quyền${what === "" ? "" : ` · ${what}`}`,
		permOk: (what) => `đã cấp quyền${what === "" ? "" : ` · ${what}`}`,
		permDenied: (what) => `từ chối quyền${what === "" ? "" : ` · ${what}`}`,
		compactStart: "bắt đầu nén ngữ cảnh",
		compactEnd: "nén ngữ cảnh xong",
		stop: "lượt xong, chờ bạn",
		stopFailure: "lượt dừng vì lỗi",
		apiError: (code) => `lỗi API ${code}`,
		bottleneck: (rule) => `⚠ điểm nghẽn · ${rule}`,
		bottleneckClosed: (rule) => `điểm nghẽn đã đóng · ${rule}`,
		ciStart: (name) => `CI${name === "" ? "" : ` ${name}`} bắt đầu`,
		ciEnd: (name, ok) => `CI${name === "" ? "" : ` ${name}`} ${ok === undefined ? "không rõ kết quả" : ok ? "đạt" : "lỗi"}`,
		git: (kind) => `git ${kind}`,
	},
	legend: [
		["Camera theo hành động.", " Đọc 20 tệp liên tiếp thì camera đứng yên ở kho tệp; chỉ đổi góc khi việc chuyển sang khối khác và giữ được ít nhất nửa giây, mỗi góc giữ tối thiểu 1,5 giây. Khoảng suy nghĩ ngắn giữa hai lần gọi không kéo camera về model."],
		["Tự động", " theo hoạt động AI · ", "Tự do", " kéo để pan, Ctrl/⌘ + cuộn để zoom (kéo hay zoom khi đang Tự động cũng tự chuyển sang Tự do) · ", "Tập trung", " khoá vào khối đang chọn (bấm một khối)."],
		["Runtime", " là thời gian của lần chạy hiện tại. ", "p95 lịch sử", " là thống kê các lần chạy trước của cùng khối. ", "Lần gọi", " là số lần gọi tool. Ba số này luôn có nhãn riêng."],
		["Tiến độ.", " Claude Code không báo phần trăm cho một lệnh, nên thanh chạy kiểu không xác định; chỉ hiện phần trăm khi có số thật."],
		["Output.", " Claude Code gửi output khi lệnh xong, nên thẻ hiện output ngay khi lệnh kết thúc; lúc đang chạy ghi rõ là chưa có."],
		["Đường dẫn", " nối đúng tác nhân (agent chính ở model, hoặc subagent đang bay quanh) tới khối nó dùng; dòng \"Hành trình\" ghi chuỗi các khối đã đi qua."],
		["Khối được lấy nét", " hiện nội dung thật: kho tệp liệt kê tệp vừa đọc/sửa, terminal hiện các lệnh, kiểm thử hiện các lần chạy, cổng MCP hiện tool vừa gọi, internet hiện tên miền."],
		["Độ dày đường dẫn", " = số lần gọi trong phiên; phần đỏ = tỷ lệ lỗi. ", "Cấp độ", ": khối chính to và rõ, khối nền nhỏ và mờ khi chưa dùng."],
	],
};

const en: ObservatoryCopy = {
	locale: "en-US",
	close: "Close",
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
	detail: {
		kinds: { prompt: "Prompt", tool: "Tool call", subagent: "Subagent", api: "API request", instruction: "Instructions loaded", git: "Git", lifecycle: "Session event", bottleneck: "Bottleneck" },
	},
	card: {
		label: "Current activity",
		status: { run: "Running", ok: "Succeeded", err: "Failed", wait: "Waiting", think: "Thinking", idle: "Idle" },
		running: "Running",
		done: "Just finished",
		failed: "Failed",
		waitKind: "Waiting for your permission",
		thinkKind: (turn) => `Thinking · API request #${turn}`,
		idleKind: "Idle",
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		subagent: (type) => `subagent ${type}`,
		subagentUnknown: "subagent",
		runtime: "Runtime",
		waited: "Waited",
		p95: "p95 history",
		calls: "Calls",
		noHistory: "first in this session, no history yet",
		historyCount: (n) => `(${n} before)`,
		overP95: "longer than the p95 history",
		thinking: "Claude is thinking",
		waitWhat: (what) => (what === "" ? "Claude asks for permission" : `Claude asks for permission: ${what}`),
		waitDesc: "Claude waits until you allow it.",
		idleWhat: "waiting for the next prompt",
		lastJob: (what, ok, runtime) => `Last job: ${what} · ${ok ? "succeeded" : "failed"} · runtime ${runtime}`,
		output: "Output",
		outputPending: "none yet, Claude Code sends the output when the call ends",
		outputEmpty: "(empty)",
		outputHidden: "Hide details is on",
		outputOff: "the project does not store content",
		outputNone: "no stored content",
		outputNotYet: "not stored yet, look again in a few seconds",
		outputLoading: "asking the machine…",
		outputFailed: "could not get it from the machine",
		outputUnavailable: "not available here",
		journey: "Journey",
		more: "View details",
	},
	camera: {
		label: "Camera mode",
		auto: "Auto",
		free: "Free",
		focus: "Focus",
		whole: "whole scene",
		note: (where, n, events) => `view: ${where} · moved ${n} times / ${events} events`,
	},
	scene: {
		tags: {
			core: "MODEL",
			"user-desk": "INPUT",
			orchestrator: "SUBAGENT",
			memory: "MEMORY",
			skills: "SKILLS",
			files: "FILES",
			mcp: "MCP GATE",
			external: "SPACE PORTAL",
			security: "LOCK",
			sandbox: "TERMINAL",
			testing: "TESTING",
			git: "GIT · CI/CD",
			monitoring: "CONTEXT POOL",
		},
		subs: {
			core: "model",
			"user-desk": "prompt",
			orchestrator: "subagent",
			memory: "CLAUDE.md",
			skills: "skill",
			files: "read · edit · search",
			mcp: "MCP servers",
			external: "internet",
			security: "permissions",
			sandbox: "shell commands",
			testing: "tests",
			git: "release pipeline",
			monitoring: "context",
		},
		calls: (n) => `${n} ${n === 1 ? "call" : "calls"}`,
		p95: (d) => `p95 hist ${d}`,
		failures: (n) => `${n} failed`,
		runtime: (d) => `runtime ${d}`,
		noCalls: "no calls yet",
		modelTitle: (model) => (model === "" ? "MODEL" : `MODEL · ${model}`),
		thinking: "THINKING",
		waiting: "WAITING FOR YOU",
		executing: "work handed out, waiting for results",
		idle: "idle",
		apiLine: (turn, k, tps) => `API turn #${turn} · ${k}k context · ${tps} tok/s`,
		contextLine: (percent, tokens, window) => `${percent === null ? "–" : `${percent}%`} · ${tokenSize(tokens)} / ${window > 0 ? tokenSize(window) : "?"}`,
		wave: (tps) => `TOKEN WAVE · ${tps} tok/s`,
		portal: "SPACE PORTAL · internet",
		subagent: (type) => `subagent · ${type}`,
		subagentShort: "subagent",
		mcpTool: "MCP tool",
		mcpServer: (n) => `server ${n}`,
		noMcp: "no MCP server used yet",
		moreServers: (n) => `+${n} more servers`,
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		stepFailed: "✗ failed",
		stepUnknown: "? unknown",
		prod: "prod",
	},
	side: {
		session: "Session",
		context: "context",
		speed: "speed",
		tokPerSec: "tok/s",
		tools: "tool calls",
		subagents: "subagents",
		detail: "Detail",
		detailHint: "Click \"See detail\" on the activity card, a module, or an event.",
		status: "Status",
		running: "running",
		ok: "succeeded",
		failed: "failed",
		runtimeNow: "Runtime (this run)",
		p95Place: "Module's p95 history",
		none: "none yet",
		callsPlace: "Module's calls",
		target: "Target",
		agent: "Agent",
		mainAgent: "main agent",
		description: "Claude's description",
		output: "Output",
		outputRunning: "none yet (Claude Code sends the output when the call ends)",
		contentNote: "Description and output are content: shown only when the project stores content and Hide details is off.",
		kind: "Kind",
		time: "Time",
		label: "Label",
		doing: "Doing",
		modes: { think: "thinking", exec: "executing (waiting for tools)", wait: "waiting for you", idle: "idle" },
		apiTurns: "API turns",
		speedRow: "Speed",
		subagentRow: "Subagents",
		used: "Used",
		ratio: "Share",
		noCallsYet: "No calls in this session yet.",
		p50p95: "p50 / p95 history",
		errors: "Failures",
		recent: "Recent (runtime of each)",
		stepRow: (step, n, p95) => `${step} · ${n}× · p95 hist ${p95}`,
		stepState: { idle: "–", run: "running", ok: "passed", err: "failed", unknown: "unknown" },
		waitingFor: "Waiting for permission",
		prompts: "Prompts in the session",
	},
	feed: {
		title: "Events",
		running: "running…",
		failed: (d) => `failed · ${d}`,
		prompt: "prompt",
		api: (turn, tokens) => `thinking · API turn #${turn}${tokens === "" ? "" : ` · ${tokens} context tokens`}`,
		subStart: (type) => `subagent ${type} started`,
		subEnd: (type) => `subagent ${type} done`,
		instruction: (what) => `loaded ${what}`,
		permAsk: (what) => `waiting for your permission${what === "" ? "" : ` · ${what}`}`,
		permOk: (what) => `permission granted${what === "" ? "" : ` · ${what}`}`,
		permDenied: (what) => `permission denied${what === "" ? "" : ` · ${what}`}`,
		compactStart: "compacting the context",
		compactEnd: "context compacted",
		stop: "turn done, waiting for you",
		stopFailure: "turn stopped on an error",
		apiError: (code) => `API error ${code}`,
		bottleneck: (rule) => `⚠ bottleneck · ${rule}`,
		bottleneckClosed: (rule) => `bottleneck closed · ${rule}`,
		ciStart: (name) => `CI${name === "" ? "" : ` ${name}`} started`,
		ciEnd: (name, ok) => `CI${name === "" ? "" : ` ${name}`} ${ok === undefined ? "outcome unknown" : ok ? "passed" : "failed"}`,
		git: (kind) => `git ${kind}`,
	},
	legend: [
		["The camera follows actions.", " Twenty file reads in a row keep it still on the files; it moves only when the work goes to another module and stays at least half a second, and holds each view at least 1.5 seconds. A short think between two calls does not pull it back to the model."],
		["Auto", " follows the AI · ", "Free", " drag to pan, Ctrl/⌘ + scroll to zoom (a drag or a zoom in Auto switches to Free) · ", "Focus", " locks on the selected module (click one)."],
		["Runtime", " is this run's time. ", "p95 history", " is over the module's earlier runs. ", "Calls", " counts tool calls. Each number has its own label."],
		["Progress.", " Claude Code reports no percentage for a call, so the bar is indeterminate; a percentage shows only when a real one is known."],
		["Output.", " Claude Code sends the output when the call ends, so the card shows it then; while it runs it says there is none yet."],
		["Traces", " join the right agent (the main one at the model, or a subagent circling it) to the module it uses; the \"Journey\" line lists the modules passed."],
		["The module in focus", " shows real content: files read or edited, terminal commands, test runs, MCP tools called, internet domains."],
		["Trace width", " = calls in the session; the red share = the failure rate. ", "Tiers", ": main modules large and clear, background ones small and dim until used."],
	],
};

const zhCN: ObservatoryCopy = {
	locale: "zh-CN",
	close: "关闭",
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
	detail: {
		kinds: { prompt: "提示", tool: "工具调用", subagent: "子代理", api: "API 请求", instruction: "加载指令", git: "Git", lifecycle: "会话事件", bottleneck: "瓶颈" },
	},
	card: {
		label: "当前活动",
		status: { run: "运行中", ok: "成功", err: "失败", wait: "等待中", think: "思考中", idle: "空闲" },
		running: "正在执行",
		done: "刚完成",
		failed: "失败",
		waitKind: "等待你授权",
		thinkKind: (turn) => `思考中 · 第 ${turn} 次 API 请求`,
		idleKind: "空闲",
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		subagent: (type) => `子代理 ${type}`,
		subagentUnknown: "子代理",
		runtime: "运行时间",
		waited: "已等待",
		p95: "历史 p95",
		calls: "调用次数",
		noHistory: "本会话首次，暂无历史",
		historyCount: (n) => `（之前 ${n} 次）`,
		overP95: "比历史 p95 更久",
		thinking: "Claude 正在思考",
		waitWhat: (what) => (what === "" ? "Claude 请求权限" : `Claude 请求权限：${what}`),
		waitDesc: "Claude 会等到你允许为止。",
		idleWhat: "等待下一个提示",
		lastJob: (what, ok, runtime) => `最后的任务：${what} · ${ok ? "成功" : "失败"} · 运行时间 ${runtime}`,
		output: "输出",
		outputPending: "暂无，Claude Code 在调用结束后发送输出",
		outputEmpty: "（空）",
		outputHidden: "已开启「隐藏详情」",
		outputOff: "该项目不保存内容",
		outputNone: "没有保存的内容",
		outputNotYet: "尚未保存，请几秒后再看",
		outputLoading: "正在向机器请求…",
		outputFailed: "未能从机器获取",
		outputUnavailable: "此处无法查看",
		journey: "路径",
		more: "查看详情",
	},
	camera: {
		label: "镜头模式",
		auto: "自动",
		free: "自由",
		focus: "聚焦",
		whole: "全景",
		note: (where, n, events) => `视角：${where} · 切换 ${n} 次 / ${events} 个事件`,
	},
	scene: {
		tags: {
			core: "模型",
			"user-desk": "输入",
			orchestrator: "子代理",
			memory: "记忆",
			skills: "技能",
			files: "文件库",
			mcp: "MCP 网关",
			external: "空间门户",
			security: "锁",
			sandbox: "终端",
			testing: "测试",
			git: "GIT · CI/CD",
			monitoring: "上下文池",
		},
		subs: {
			core: "模型",
			"user-desk": "提示",
			orchestrator: "子代理",
			memory: "CLAUDE.md",
			skills: "技能",
			files: "读 · 改 · 搜",
			mcp: "MCP 服务器",
			external: "互联网",
			security: "权限",
			sandbox: "shell 命令",
			testing: "测试",
			git: "发布流水线",
			monitoring: "上下文",
		},
		calls: (n) => `${n} 次调用`,
		p95: (d) => `历史 p95 ${d}`,
		failures: (n) => `${n} 次失败`,
		runtime: (d) => `运行 ${d}`,
		noCalls: "还没有调用",
		modelTitle: (model) => (model === "" ? "模型" : `模型 · ${model}`),
		thinking: "思考中",
		waiting: "等你操作",
		executing: "已分派任务，等待结果",
		idle: "空闲",
		apiLine: (turn, k, tps) => `第 ${turn} 次 API 请求 · ${k}k 上下文 · ${tps} tok/s`,
		contextLine: (percent, tokens, window) => `${percent === null ? "–" : `${percent}%`} · ${tokenSize(tokens)} / ${window > 0 ? tokenSize(window) : "?"}`,
		wave: (tps) => `TOKEN 波 · ${tps} tok/s`,
		portal: "空间门户 · 互联网",
		subagent: (type) => `子代理 · ${type}`,
		subagentShort: "子代理",
		mcpTool: "MCP 工具",
		mcpServer: (n) => `服务器 ${n}`,
		noMcp: "尚未使用 MCP 服务器",
		moreServers: (n) => `另有 ${n} 个服务器`,
		steps: { commit: "commit", push: "push", ci: "CI", deploy: "deploy" },
		stepFailed: "✗ 失败",
		stepUnknown: "? 未知",
		prod: "prod",
	},
	side: {
		session: "会话",
		context: "上下文",
		speed: "速度",
		tokPerSec: "tok/s",
		tools: "工具调用",
		subagents: "子代理",
		detail: "详情",
		detailHint: "点击活动卡片上的「查看详情」、某个模块或某条事件。",
		status: "状态",
		running: "运行中",
		ok: "成功",
		failed: "失败",
		runtimeNow: "运行时间（本次）",
		p95Place: "模块历史 p95",
		none: "暂无",
		callsPlace: "模块调用次数",
		target: "目标",
		agent: "执行者",
		mainAgent: "主代理",
		description: "Claude 的说明",
		output: "输出",
		outputRunning: "暂无（Claude Code 在调用结束后发送输出）",
		contentNote: "说明和输出属于内容：仅当项目保存内容且「隐藏详情」关闭时显示。",
		kind: "类型",
		time: "时间",
		label: "标签",
		doing: "正在",
		modes: { think: "思考", exec: "执行（等待工具）", wait: "等你操作", idle: "空闲" },
		apiTurns: "API 请求",
		speedRow: "速度",
		subagentRow: "子代理",
		used: "已用",
		ratio: "比例",
		noCallsYet: "本会话还没有调用。",
		p50p95: "历史 p50 / p95",
		errors: "失败",
		recent: "最近（每次运行时间）",
		stepRow: (step, n, p95) => `${step} · ${n} 次 · 历史 p95 ${p95}`,
		stepState: { idle: "–", run: "运行中", ok: "通过", err: "失败", unknown: "未知" },
		waitingFor: "等待授权",
		prompts: "会话中的提示",
	},
	feed: {
		title: "事件",
		running: "运行中…",
		failed: (d) => `失败 · ${d}`,
		prompt: "提示",
		api: (turn, tokens) => `思考 · 第 ${turn} 次 API 请求${tokens === "" ? "" : ` · 上下文 ${tokens} token`}`,
		subStart: (type) => `子代理 ${type} 开始`,
		subEnd: (type) => `子代理 ${type} 完成`,
		instruction: (what) => `加载 ${what}`,
		permAsk: (what) => `等待你授权${what === "" ? "" : ` · ${what}`}`,
		permOk: (what) => `已授权${what === "" ? "" : ` · ${what}`}`,
		permDenied: (what) => `拒绝授权${what === "" ? "" : ` · ${what}`}`,
		compactStart: "开始压缩上下文",
		compactEnd: "上下文压缩完成",
		stop: "本轮完成，等你操作",
		stopFailure: "本轮因错误停止",
		apiError: (code) => `API 错误 ${code}`,
		bottleneck: (rule) => `⚠ 瓶颈 · ${rule}`,
		bottleneckClosed: (rule) => `瓶颈已关闭 · ${rule}`,
		ciStart: (name) => `CI${name === "" ? "" : ` ${name}`} 开始`,
		ciEnd: (name, ok) => `CI${name === "" ? "" : ` ${name}`} ${ok === undefined ? "结果未知" : ok ? "通过" : "失败"}`,
		git: (kind) => `git ${kind}`,
	},
	legend: [
		["镜头跟随动作。", " 连续读取 20 个文件时镜头停在文件库；只有工作转到其他模块并持续至少半秒才切换，每个视角至少保持 1.5 秒。两次调用之间的短暂思考不会把镜头拉回模型。"],
		["自动", " 跟随 AI · ", "自由", " 拖动平移，Ctrl/⌘ + 滚轮缩放（在自动模式下拖动或缩放会切到自由） · ", "聚焦", " 锁定所选模块（点击一个模块）。"],
		["运行时间", " 是本次运行的时间。", "历史 p95", " 统计同一模块之前的运行。", "调用次数", " 是工具调用次数。三个数字各有标签。"],
		["进度。", " Claude Code 不报告单次调用的百分比，所以进度条是不确定式的；只有真实数字时才显示百分比。"],
		["输出。", " Claude Code 在调用结束后发送输出，所以卡片在结束时显示；运行中会注明暂无。"],
		["连线", " 把正确的执行者（模型处的主代理，或绕行的子代理）连到它使用的模块；「路径」一行列出经过的模块。"],
		["聚焦的模块", " 显示真实内容：读取或修改的文件、终端命令、测试运行、调用的 MCP 工具、互联网域名。"],
		["连线粗细", " = 本会话调用次数；红色部分 = 失败率。", "层级", "：主模块大而清晰，背景模块小，未使用时变暗。"],
	],
};

export const OBSERVATORY_COPY: Readonly<Record<Locale, ObservatoryCopy>> = { vi, en, "zh-CN": zhCN };

/** The Live Map's copy in the UI language. */
export function useObservatoryCopy(): ObservatoryCopy {
	return OBSERVATORY_COPY[useI18n().locale];
}
