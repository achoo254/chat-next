// A machine of the account for the visual harness: the real handshake and
// sealed frames (FakeMachine) behind the browser's WebSocket for one tunnel
// address, its key listed in the directory, and a session with long shell
// commands, an answered and a pending permission prompt, a grouped run, a
// markdown answer (list, tasks, table, a code block wider than a phone),
// diffs of two files (one more edited by a subagent), the turn's numbers
// (tunelo 2.0.11), the folder's uncommitted changes as git sees them, a
// command reading a sign-in secret (?open=secret-command), and the
// statusline data (ThreadInfo) with commands and
// skills; the machine's Claude profiles announced unasked, the session
// switching account after its turn, a running session out of usage with a
// suggestion; previews; a running and a parked session in two folders; a
// message with an image and a file (the image fetched back over the link),
// uploads acknowledged piece by piece (a file named "stall-…" stops at about
// 40 %, to show the progress); and beside it a machine this browser has not
// paired with and one that is offline.
// Test-only: never part of the production build.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AccountStatus, Decision, GitFileState, ItemSchema, LoginState, ProjectConfigLevel, PromptState, Role, TerminalAvailability, ThreadState, ToolKind, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { brand } from "../../src/brand.ts";
import { deviceKeyStore } from "../../src/machines/link/device-keys.ts";
import { defaultAnswer, FakeMachine, type Body as FrameBody } from "../machines/fake-machine.ts";
import { FakeTerminalHost } from "../machines/fake-terminal.ts";
import { FakeRfb } from "./fake-rfb.ts";
import { FakeUsage } from "./fake-usage.ts";
import { FakeWorkspace } from "./fake-workspace.ts";
import type { FakeMachines } from "./fake-machines.ts";

export const DEMO_THREAD = "demo-thread";
const DEMO_IMAGE = "demo-image-1";

/** A small screenshot-like PNG for the demo message's image. */
async function demoImage(): Promise<Uint8Array> {
	const canvas = document.createElement("canvas");
	canvas.width = 240;
	canvas.height = 160;
	const c = canvas.getContext("2d");
	if (c === null) return new Uint8Array();
	c.fillStyle = "#f4f6fa";
	c.fillRect(0, 0, 240, 160);
	c.fillStyle = "#2f6bff";
	c.fillRect(0, 0, 240, 24);
	c.fillStyle = "#d8dee9";
	for (let y = 40; y < 150; y += 22) c.fillRect(16, y, 140 + ((y * 7) % 60), 10);
	c.fillStyle = "#ff6b6b";
	c.fillRect(196, 40, 60, 40);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	return blob === null ? new Uint8Array() : new Uint8Array(await blob.arrayBuffer());
}

/** What the machine's browser shows in the demo: a sign-in page, as a JPEG like the screencast's. */
async function demoBrowserPicture(): Promise<Uint8Array> {
	const canvas = document.createElement("canvas");
	canvas.width = 1200;
	canvas.height = 800;
	const c = canvas.getContext("2d");
	if (c === null) return new Uint8Array();
	c.fillStyle = "#f6f8fa";
	c.fillRect(0, 0, 1200, 800);
	c.fillStyle = "#24292f";
	c.fillRect(0, 0, 1200, 64);
	c.fillStyle = "#ffffff";
	c.font = "600 22px sans-serif";
	c.fillText("accounts.example.com", 32, 40);
	c.fillStyle = "#ffffff";
	c.fillRect(400, 150, 400, 470);
	c.strokeStyle = "#d0d7de";
	c.strokeRect(400, 150, 400, 470);
	c.fillStyle = "#24292f";
	c.font = "600 30px sans-serif";
	c.fillText("Đăng nhập", 430, 215);
	c.font = "18px sans-serif";
	c.fillText("Email", 430, 270);
	c.fillText("Mật khẩu", 430, 375);
	c.strokeRect(430, 285, 340, 48);
	c.strokeStyle = "#0969da";
	c.lineWidth = 3;
	c.strokeRect(430, 390, 340, 48);
	c.fillStyle = "#57606a";
	c.fillText("dieuvy@example.com", 445, 316);
	c.fillText("••••••••", 445, 421);
	c.fillStyle = "#1f883d";
	c.fillRect(430, 470, 340, 52);
	c.fillStyle = "#ffffff";
	c.font = "600 20px sans-serif";
	c.fillText("Tiếp tục", 556, 503);
	c.fillStyle = "#0969da";
	c.font = "17px sans-serif";
	c.fillText("Đăng nhập bằng passkey", 500, 575);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.6));
	return blob === null ? new Uint8Array() : new Uint8Array(await blob.arrayBuffer());
}

/** The machine's screen in the demo: a desktop with a passkey sheet waiting, as RGBA. */
function demoScreen(): { width: number; height: number; rgba: Uint8ClampedArray } {
	const width = 1280;
	const height = 800;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const c = canvas.getContext("2d");
	if (c === null) return { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
	const sky = c.createLinearGradient(0, 0, width, height);
	sky.addColorStop(0, "#3a5f9e");
	sky.addColorStop(1, "#8a6fb3");
	c.fillStyle = sky;
	c.fillRect(0, 0, width, height);
	c.fillStyle = "rgba(255,255,255,0.85)";
	c.fillRect(0, 0, width, 26);
	c.fillStyle = "#1d1d1f";
	c.font = "600 14px sans-serif";
	c.fillText("Google Chrome   Tệp   Sửa   Xem", 40, 18);
	c.fillStyle = "#f5f5f7";
	c.fillRect(120, 70, 1040, 640);
	c.fillStyle = "#e3e3e8";
	c.fillRect(120, 70, 1040, 40);
	c.fillStyle = "rgba(0,0,0,0.35)";
	c.fillRect(120, 110, 1040, 600);
	c.fillStyle = "#ffffff";
	c.fillRect(440, 230, 400, 320);
	c.fillStyle = "#1d1d1f";
	c.font = "600 20px sans-serif";
	c.fillText("Đăng nhập bằng passkey", 520, 290);
	c.font = "15px sans-serif";
	c.fillText("accounts.example.com muốn xác minh danh tính.", 470, 330);
	c.fillText("Nhập mật khẩu của máy để cho phép.", 500, 355);
	c.strokeStyle = "#0a84ff";
	c.lineWidth = 3;
	c.strokeRect(480, 385, 320, 40);
	c.fillStyle = "#e5e5ea";
	c.fillRect(480, 470, 150, 40);
	c.fillStyle = "#0a84ff";
	c.fillRect(650, 470, 150, 40);
	c.fillStyle = "#1d1d1f";
	c.fillText("Huỷ", 540, 496);
	c.fillStyle = "#ffffff";
	c.fillText("Tiếp tục", 695, 496);
	return { width, height, rgba: c.getImageData(0, 0, width, height).data };
}

const TUNNEL = `wss://demo.tunnel.${brand.domain}`;

type Body = NonNullable<MessageInitShape<typeof ItemSchema>["body"]>;

function transcript(now: number): Item[] {
	let seq = 0n;
	const item = (id: string, body: Body, revision = 1): Item => {
		seq += 1n;
		return create(ItemSchema, { id, seq, revision, at: BigInt(now - 600_000) + seq * 1000n, provider: "claude", model: "opus", body });
	};
	const bash = (toolId: string, summary: string): Body => ({ case: "toolCall", value: { toolId, kind: ToolKind.SHELL, name: "Bash", summary, input: "{}" } });
	const done = (toolId: string, output: string): Body => ({ case: "toolResult", value: { toolId, ok: true, output } });
	const longCommand =
		'cd "D:\\CONG VIEC\\hoandat-app\\chat-next" && pnpm --filter @app/web exec vitest run test/machines/chat-ui.test.tsx test/machines/transcript.test.ts --reporter=verbose --coverage.enabled=true --coverage.include=src/machines/**/*.tsx 2>&1 | tail -n 40';
	return [
		item("u1", {
			case: "text",
			value: {
				role: Role.USER,
				text: "Chạy test của màn Máy của tôi rồi sửa chỗ lỗi giúp mình",
				attachments: [
					{ id: DEMO_IMAGE, name: "man-may-375.png", mimeType: "image/png", size: 48_213n, image: true },
					{ id: "demo-file-1", name: "loi-tran-ngang.log", mimeType: "text/plain", size: 3_412n, path: ".tunelo-attachments/2026-11-09/loi-tran-ngang.log" },
				],
			},
		}),
		item("turn1", {
			case: "turn",
			value: {
				state: TurnState.COMPLETED,
				durationMs: 77_400n,
				contextTokens: 68_000n,
				contextWindow: 200_000n,
				model: "claude-opus-4-7",
				inputTokens: 1_240n,
				outputTokens: 6_830n,
				cacheReadTokens: 412_000n,
				cacheWriteTokens: 18_400n,
				durationApiMs: 58_200n,
				numTurns: 14,
				costUsdEstimate: 1.2734,
			},
		}),
		item("a1", { case: "text", value: { role: Role.ASSISTANT, text: "Mình chạy bộ test trước để xem trạng thái hiện tại." } }),
		item("t1", bash("1", longCommand)),
		item("p1", { case: "approval", value: { toolId: "1", kind: ToolKind.SHELL, name: "Bash", summary: longCommand, state: PromptState.ANSWERED, decision: Decision.ALLOW_SESSION } }, 2),
		item("r1", done("1", " Test Files  5 passed (5)\n      Tests  52 passed (52)")),
		item("a1b", {
			case: "text",
			value: {
				role: Role.ASSISTANT,
				text: [
					"Test đều qua (**52/52**). Chỗ cột tool bị tràn ngang do `white-space: nowrap` trên lệnh dài:",
					"",
					"1. Lệnh xuống dòng và gói trong 3 dòng, có **Xem thêm**.",
					"2. Kết quả nằm sau nút `Kết quả`.",
					"- [x] Sửa CSS",
					"- [ ] Chụp lại ảnh 375 px",
					"",
					"| Khổ | Trước | Sau |",
					"|---|---:|---:|",
					"| 375 px | tràn 212 px | 0 |",
					"| 1440 px | 0 | 0 |",
					"",
					"```css",
					"/* lệnh dài xuống dòng, tối đa 3 dòng */",
					".mx-run-cmd.clamp { display: -webkit-box; -webkit-line-clamp: 3; overflow: hidden; } .mx-run-cmd { overflow-wrap: anywhere; }",
					"```",
					"",
					"Xem thêm ở [tài liệu CSS](https://developer.mozilla.org/docs/Web/CSS/overflow-wrap).",
				].join("\n"),
			},
		}),
		item("t2", { case: "toolCall", value: { toolId: "2", kind: ToolKind.READ, name: "Read", summary: "apps/web/src/machines/cards/tool-run.tsx", input: "{}" } }),
		item("r2", done("2", "…")),
		item("t3", { case: "toolCall", value: { toolId: "3", kind: ToolKind.SEARCH, name: "Grep", summary: "overflow-wrap:anywhere apps/web/src/machines/machines.css", input: "{}" } }),
		item("r3", done("3", "machines.css:55")),
		item("d1", {
			case: "diff",
			value: {
				toolId: "4",
				path: "apps/web/src/machines/machines.css",
				unified: "@@ -146,3 +146,4 @@\n-.mx-tools li .mono { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--c-text-muted); }\n+.mx-run-cmd { min-width: 0; overflow-wrap: anywhere; word-break: break-word; line-height: 1.45; }\n+.mx-run-cmd.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }",
				added: 2,
				removed: 1,
			},
		}),
		item("d2", {
			case: "diff",
			value: {
				toolId: "6",
				path: "apps/web/src/machines/cards/tool-run.tsx",
				unified: "@@ -40,4 +40,5 @@\n \tconst rows = runs.map((run) => (\n-\t\t<RunRow key={run.id} run={run} />\n+\t\t// One row per call; the answered prompt folds in.\n+\t\t<RunRow key={run.id} run={run} running={run === running} />\n \t));",
				added: 2,
				removed: 1,
			},
		}),
		item("d3", {
			case: "diff",
			value: {
				toolId: "7",
				path: "apps/web/src/machines/machines.css",
				unified: "@@ -210,2 +210,2 @@\n-.mx-diff pre span { white-space: pre-wrap; }\n+.mx-diff-body td { white-space: pre; }",
				added: 1,
				removed: 1,
			},
		}),
		item("t8", { case: "toolCall", value: { toolId: "8", kind: ToolKind.SUBAGENT, name: "Task", summary: "Rà lại CSS của thẻ tool ở khổ 375", input: "{}" } }),
		item("s8", { case: "subagent", value: { toolId: "8", description: "Rà lại CSS của thẻ tool ở khổ 375", done: true } }),
		item("r8", done("8", "Đã sửa 1 file.")),
		item("d8", {
			case: "diff",
			value: {
				toolId: "9",
				parentToolId: "8",
				path: "apps/web/src/machines/cards/tool-run.css",
				unified: "@@\n-.mx-run { gap: 4px; }\n+.mx-run { gap: var(--space-1); }",
				added: 1,
				removed: 1,
			},
		}),
		item("u2", { case: "text", value: { role: Role.USER, text: "Ok, build lại luôn nhé" } }),
		item("turn2", { case: "turn", value: { state: TurnState.RUNNING } }),
		item("a2", { case: "text", value: { role: Role.ASSISTANT, text: "Mình xoá thư mục build cũ rồi chạy lại." } }),
		item("t5", bash("5", "rm -rf apps/web/dist apps/web/test/visual/dist && pnpm --filter @app/web build")),
		new URLSearchParams(window.location.search).get("open") === "secret-command"
			? item("p5", {
					case: "approval",
					value: {
						toolId: "5",
						kind: ToolKind.SHELL,
						name: "Bash",
						summary: SECRET_COMMAND,
						input: JSON.stringify({ command: SECRET_COMMAND }),
						state: PromptState.PENDING,
						secrets: [
							{ name: "GITHUB_TOKEN", origin: "https://api.github.com" },
							{ name: "STAGING_ADMIN", origin: "" },
						],
					},
				})
			: item("p5", { case: "approval", value: { toolId: "5", kind: ToolKind.SHELL, name: "Bash", summary: "rm -rf apps/web/dist apps/web/test/visual/dist && pnpm --filter @app/web build", reason: "Xoá thư mục build", state: PromptState.PENDING } }),
	];
}

const SECRET_COMMAND = 'curl -sf -H "Authorization: Bearer $TUNELO_SECRET_GITHUB_TOKEN" https://api.github.com/user && echo ${TUNELO_SECRET_STAGING_ADMIN:+set}';

/** The demo session's folder as git sees it: an edit by a shell command, a new file, a deleted one, a sensitive one. */
function gitFiles() {
	const file = (path: string, state: GitFileState, added: number, removed: number, unified: string, extra: { truncated?: boolean; sensitive?: boolean; binary?: boolean } = {}) => ({
		path,
		state,
		added,
		removed,
		unified,
		truncated: extra.truncated ?? false,
		sensitive: extra.sensitive ?? false,
		binary: extra.binary ?? false,
	});
	return [
		file("apps/web/src/machines/machines.css", GitFileState.MODIFIED, 3, 2, "--- a/apps/web/src/machines/machines.css\n+++ b/apps/web/src/machines/machines.css\n@@ -146,3 +146,4 @@\n-.mx-tools li .mono { white-space: nowrap; }\n+.mx-run-cmd { overflow-wrap: anywhere; }\n+.mx-run-cmd.clamp { -webkit-line-clamp: 3; }\n@@ -210,2 +210,2 @@\n-.mx-diff pre span { white-space: pre-wrap; }\n+.mx-diff-body td { white-space: pre; }"),
		file("apps/web/package.json", GitFileState.MODIFIED, 1, 1, "--- a/apps/web/package.json\n+++ b/apps/web/package.json\n@@ -12,1 +12,1 @@\n-    \"vite\": \"8.3.3\",\n+    \"vite\": \"8.3.4\","),
		file("apps/web/test/visual/shots/man-may-375.png", GitFileState.UNTRACKED, 0, 0, "", { binary: true }),
		file("docs/notes/build-log.md", GitFileState.UNTRACKED, 4, 0, "--- /dev/null\n+++ b/docs/notes/build-log.md\n@@ -0,0 +1,4 @@\n+# Build\n+\n+pnpm --filter @app/web build\n+OK, 0 cảnh báo", { truncated: true }),
		file("apps/web/src/legacy-styles.css", GitFileState.DELETED, 0, 38, "--- a/apps/web/src/legacy-styles.css\n+++ /dev/null\n@@ -1,38 +0,0 @@\n-.legacy { display: none; }"),
		file(".env.local", GitFileState.MODIFIED, 0, 0, "", { sensitive: true }),
	];
}

/** Adds the machine (with its key) to `machines`, trusts this browser's key on it and answers its link; resolves with its ref. */
export async function installRemoteMachineDemo(machines: FakeMachines): Promise<string> {
	const now = Date.now();
	const machine = await FakeMachine.create();
	const keys = deviceKeyStore();
	const device = await keys.device();
	machine.trusted = [device.publicKey];
	const entry = machines.add({
		name: "DIEUVY-LAPTOP",
		os: "win32",
		arch: "x64",
		tunnelUrl: TUNNEL,
		lastSeenAt: BigInt(Math.floor(now / 1000)),
		agentVersion: "2.0.1",
		publicKey: machine.keys.publicKey,
	});
	const ref = String(entry.id);
	const image = await demoImage();
	const browserPicture = await demoBrowserPicture();
	const at = new URLSearchParams(window.location.search).get("at");
	const browserTabs = [
		{ targetId: "T1", url: "https://accounts.example.com/login?next=%2Fsettings%2Fsecurity", title: "Đăng nhập · Example" },
		{ targetId: "T2", url: "http://localhost:5173/settings", title: "Cài đặt · ứng dụng của bạn" },
	];
	/** The machine's Screen Sharing in the demo (?at=machine-screen-…): off, open to the network with Apple's sign-in, or on. */
	let rfb: FakeRfb | null = null;
	const takeover = {
		osDialog: at === "machine-os-dialog",
		takeoverId: "demo-takeover",
		threadId: "demo-idle",
		reason: "Đăng nhập tài khoản Example giúp mình (trang đòi mã 2 bước), rồi bấm Trả lại để mình chạy tiếp test e2e.",
		url: browserTabs[0]?.url ?? "",
		expiresAt: BigInt(now + 10 * 60_000),
	};
	// The machine's terminal (?at=machine-terminal): shells that echo what is typed, on the relay (a real
	// browser's offer gets no direct path from the fake). The e2e spec reads it as window.__fakeTerminal.
	const terminalHost = new FakeTerminalHost(machine);
	terminalHost.greeting = "dieuvy@laptop ~ % ";
	(window as unknown as { __fakeTerminal?: FakeTerminalHost }).__fakeTerminal = terminalHost;
	// The workspace panel of project pr1 (the demo session's folder): files and git in memory; the e2e reads it as window.__fakeWorkspace.
	const workspace = new FakeWorkspace("pr1");
	(window as unknown as { __fakeWorkspace?: FakeWorkspace }).__fakeWorkspace = workspace;
	// "Hiệu quả" of the machine: the demo folder's usage in memory; the e2e reads it as window.__fakeUsage.
	const usageSide = new FakeUsage("local:chat-next");
	(window as unknown as { __fakeUsage?: FakeUsage }).__fakeUsage = usageSide;
	/** Uploads named "stall-…": pieces past this many bytes are never acknowledged. */
	const stalled = new Map<string, number>();
	/** Folders whose .claude configuration is on (ProjectConfigSet); every other one is off. The e2e reads it as window.__fakeProjectConfig. */
	const configOn = new Set<string>();
	(window as unknown as { __fakeProjectConfig?: Set<string> }).__fakeProjectConfig = configOn;
	const levelOf = (dir: string) => (configOn.has(dir) ? ProjectConfigLevel.FULL : ProjectConfigLevel.OFF);
	const thread = {
		id: DEMO_THREAD,
		title: "Sửa giao diện Máy của tôi",
		dir: "D:\\CONG VIEC\\hoandat-app\\chat-next",
		provider: "claude",
		model: "opus",
		state: ThreadState.WAITING,
		pending: 1,
		updatedAt: BigInt(now),
		open: true,
		preview: "Mình xoá thư mục build cũ rồi chạy lại.",
		previewTool: "",
		projectConfig: ProjectConfigLevel.OFF,
	};
	const projectList = (): FrameBody => ({
		case: "projectListResult",
		value: {
			projects: [
				{ id: "pr1", name: "chat-next", dir: "D:\\CONG VIEC\\hoandat-app\\chat-next", pinned: true, git: { git: true, branch: "main", changed: 4, ahead: 2, upstream: true } },
				{ id: "pr2", name: "localman-next", dir: "D:\\CONG VIEC\\hoandat-app\\localman-next", git: { git: true, branch: "feat/forward", changed: 0, behind: 1, upstream: true } },
				{ id: "pr3", name: "auth-next", dir: "D:\\CONG VIEC\\hoandat-app\\auth-next", git: { git: true, branch: "main" } },
			].map((p) => ({ ...p, projectConfig: levelOf(p.dir) })),
			suggestions: [{ dir: "D:\\CONG VIEC\\hoandat-app\\kb-next", sessions: 6 }],
		},
	});
	const others = [
		{ id: "demo-running", title: "Viết test cho bảng Cần bạn", dir: "D:\\CONG VIEC\\hoandat-app\\chat-next", provider: "claude", model: "sonnet", state: ThreadState.RUNNING, pending: 0, updatedAt: BigInt(now - 60_000), open: true, preview: "", previewTool: "Bash" },
		{ id: "demo-idle", title: "Rà soát quyền MCP của tunelo", dir: "D:\\CONG VIEC\\hoandat-app\\localman-next", provider: "claude", model: "opus", state: ThreadState.IDLE, pending: 0, updatedAt: BigInt(now - 3 * 3_600_000), open: false, preview: "Đã rà 12 tool MCP: tool ghi đều hỏi lại, tool đọc chạy thẳng.", previewTool: "" },
		// The phone sidebar's cases: an open chat with a short title, sessions held by the terminal (idle, and working) with long titles.
		{ id: "demo-hi", title: "hi", dir: "D:\\CONG VIEC\\hoandat-app\\chat-next", provider: "claude", model: "opus", state: ThreadState.IDLE, pending: 0, updatedAt: BigInt(now - 30 * 60_000), open: true, preview: "Chào bạn, mình giúp gì được?", previewTool: "" },
		{ id: "demo-held", title: "Phiên AI agent không tiếp tục được sau khi khởi động lại máy", dir: "D:\\CONG VIEC\\hoandat-app\\chat-next", provider: "claude", model: "opus", state: ThreadState.IDLE, pending: 0, updatedAt: BigInt(now - 8 * 3_600_000), open: false, preview: "Tất cả đã commit và lên production.", previewTool: "", terminalSession: 2 },
		{ id: "demo-held-busy", title: "Sửa bố cục cột AI Agent trên điện thoại cho gọn", dir: "D:\\CONG VIEC\\hoandat-app\\localman-next", provider: "claude", model: "opus", state: ThreadState.IDLE, pending: 0, updatedAt: BigInt(now - 2 * 60_000), open: false, preview: "", previewTool: "Edit", terminalSession: 3, busyElsewhere: true, elsewhereActiveAt: BigInt(now - 20_000) },
	];
	// A machine this browser has not paired with, and one that went offline.
	machines.add({ name: "Mac mini", os: "darwin", arch: "arm64", tunnelUrl: `wss://other.tunnel.${brand.domain}`, lastSeenAt: BigInt(Math.floor(now / 1000)), agentVersion: "2.0.1" });
	machines.add({ name: "Máy nhà", os: "linux", arch: "x64", tunnelUrl: "", lastSeenAt: BigInt(Math.floor(now / 1000) - 2 * 3600), agentVersion: "2.0.1" });
	const usage = (five: number, week: number) => ({ fiveHour: { utilization: five, resetsAt: BigInt(now + 3_600_000) }, sevenDay: { utilization: week, resetsAt: BigInt(now + 3 * 86_400_000) } });
	const accounts = {
		selectedByProvider: { claude: "p2", antigravity: "" },
		actions: [
			{ provider: "claude", signIn: true, usage: true },
			{ provider: "antigravity", captureCurrent: true },
		],
		accounts: [
			{ provider: "antigravity", id: "", email: "user@gmail.com", status: AccountStatus.OK, current: true },
			{ provider: "antigravity", id: "g2", email: "work@example.com", status: AccountStatus.OK, createdAt: BigInt(now - 86_400_000) },
			{ provider: "claude", id: "", email: "user@example.com", organization: "Acme", plan: "team", status: AccountStatus.OK, usage: usage(100, 64), usageUpdatedAt: BigInt(now - 120_000) },
			{ provider: "claude", id: "p2", email: "user.max@example.com", plan: "max", status: AccountStatus.OK, usage: usage(4, 80), usageUpdatedAt: BigInt(now - 60_000) },
			{ provider: "claude", id: "p3", email: "user.pro@example.com", plan: "pro", status: AccountStatus.NEEDS_SIGN_IN },
		],
	};
	machine.handler = (frame, socket) => {
		switch (frame.body.case) {
			case "accountList":
			case "accountSelect":
			case "accountCaptureCurrent":
			case "usageRefresh":
				return [{ case: "accountListResult", value: accounts }];
			case "machineInfoRequest":
				// Claude waits for a sign-in secret in the idle demo session (?at=machine-secret).
				if (new URLSearchParams(window.location.search).get("at") === "machine-secret") {
					setTimeout(
						() =>
							machine.send(socket, {
								case: "secretPrompt",
								value: {
									requestId: "demo-secret",
									threadId: "demo-idle",
									name: "GITHUB_PASSWORD",
									purpose: "Đăng nhập GitHub trong trình duyệt để chạy test e2e của trang cài đặt.",
									origin: "https://github.com",
									expiresAt: BigInt(now + 5 * 60_000),
								},
							}),
						0,
					);
				}
				// Claude waits for the user on the machine's browser (?at=machine-takeover), or a page asked for a passkey (?at=machine-passkey).
				if (at === "machine-takeover" || at === "machine-os-dialog") setTimeout(() => machine.send(socket, { case: "browserTakeover", value: takeover }), 0);
				if (at === "machine-passkey") {
					setTimeout(
						() => machine.send(socket, { case: "passkeyNotice", value: { origin: "https://accounts.example.com", create: false, threadId: "demo-idle", at: BigInt(now) } }),
						0,
					);
				}
				// The machine announces its accounts unasked (id "") to every device.
				setTimeout(
					() =>
						machine.send(socket, {
							case: "machineAccounts",
							value: {
								accounts,
								sessions: [
									{ threadId: DEMO_THREAD, accountId: "", switchPending: true, provider: "claude" },
									{ threadId: "demo-running", accountId: "", switchPending: false, provider: "claude" },
									{ threadId: "demo-idle", accountId: "p2", switchPending: false, provider: "claude" },
								],
							},
						}),
					0,
				);
				return [
					{
						case: "machineInfo",
						value: {
							name: "DIEUVY-LAPTOP",
							os: "win32",
							agentVersion: "2.0.11",
							secrets: true,
							gitChanges: true,
							browser: { available: true, running: true, clearable: true },
							screenShare: true,
							terminal: TerminalAvailability.AVAILABLE,
							maxSessions: 3,
							openSessions: 1,
							providers: [
								{
									id: "claude",
									name: "Claude Code",
									version: "2.1.0",
									loginState: LoginState.OK,
									capabilities: {
										sessionAllow: true,
										images: true,
										terminal: true,
										accounts: true,
										sessionMcp: true,
										permissionModes: ["default", "acceptEdits", "plan", "auto"],
										bypassModeId: "bypassPermissions",
										models: [{ id: "opus", name: "Opus 4.7" }, { id: "sonnet", name: "Sonnet 4.6" }],
									},
								},
								{
									id: "antigravity",
									name: "Antigravity",
									version: "1.5.8",
									loginState: LoginState.OK,
									capabilities: { sessionAllow: true, accounts: true, terminal: true, permissionModes: ["default", "accept-edits", "auto", "plan"], bypassModeId: "full-access" },
								},
							],
							attachments: { fileMaxBytes: 25n * 1024n * 1024n, messageMaxBytes: 50n * 1024n * 1024n, messageMaxFiles: 10, imageMaxBytes: 3_932_160n, pieceMaxBytes: 64 * 1024 },
							devices: [
								{ publicKey: device.publicKey, name: "Chrome · Windows", addedAt: BigInt(now - 3 * 86_400_000) },
								{ publicKey: new Uint8Array(32).fill(7), name: "Safari · iPhone của Đạt", addedAt: BigInt(now - 20 * 86_400_000) },
							],
						},
					},
				];
			case "threadList":
				return [{ case: "threadListResult", value: { threads: [thread, ...others], openSessions: 2, maxSessions: 3 } }];
			case "threadSubscribe": {
				const threadId = frame.body.value.threadId;
				setTimeout(
					() =>
						machine.send(socket, {
							case: "threadInfo",
							value: {
								threadId,
								accountId: "",
								machineAccountId: "p2",
								account: { email: "user@example.com", organization: "Acme", plan: "team" },
								accountSwitchPending: threadId === DEMO_THREAD,
								...(threadId === DEMO_THREAD ? { nextAccount: { email: "user.max@example.com", plan: "max" } } : {}),
								...(threadId === "demo-running" ? { accountSuggestion: { accountId: "p2", email: "user.max@example.com", remaining: 20, provider: "claude" } } : {}),
								permissionMode: "acceptEdits",
								gitBranch: "main",
								linesAdded: 22,
								linesRemoved: 27,
								rateLimits: {
									// The session's account (the team one) ran out of its 5 hours.
									fiveHour: { utilization: 100, resetsAt: BigInt(now + (4 * 60 + 31) * 60_000) },
									sevenDay: { utilization: 64, resetsAt: BigInt(now + 2 * 86_400_000 + 3_600_000) },
								},
								commands: [
									{ name: "review", description: "Review the current changes", builtin: true },
									{ name: "compact", description: "Clear history but keep a summary in context", argumentHint: "[instructions]", builtin: true },
									{ name: "ak-cook", description: "Implement a feature end to end with tests and review", argumentHint: "[task]" },
									{ name: "ak-debug", description: "Find the root cause of a bug before fixing it" },
								],
							},
						}),
					0,
				);
				return threadId === DEMO_THREAD
					? [{ case: "threadItems", value: { threadId, items: transcript(now), cursor: { epoch: 1n, seq: 100n } } }]
					: defaultAnswer(frame);
			}
			case "dirList": {
				// A Windows home with the demo session's project folder beneath it.
				const home = "C:\\Users\\dieuvy";
				const path = frame.body.value.path === "" ? home : frame.body.value.path;
				const parent = path.includes("\\") ? path.slice(0, path.lastIndexOf("\\")) : "";
				const entries = [
					{ name: "apps", git: false, branch: "", sensitive: false },
					{ name: "docs", git: false, branch: "", sensitive: false },
					{ name: "server", git: true, branch: "main", sensitive: false },
				];
				return [{ case: "dirListResult", value: { path, parent, entries, sensitive: path === home } }];
			}
			case "fileList": {
				const prefix = frame.body.value.prefix.toLowerCase();
				const all = ["apps/", "apps/web/src/machines/composer.tsx", "apps/web/src/machines/machines.css", "apps/web/src/machines/session-chat.tsx", "docs/adr/0013-remote-machines.md"];
				const entries = all.filter((p) => p.toLowerCase().includes(prefix)).map((path) => ({ path, dir: path.endsWith("/") }));
				return [{ case: "fileListResult", value: { threadId: frame.body.value.threadId, entries, truncated: false } }];
			}
			case "sessionList": {
				// Claude Code sessions kept on the machine: from a terminal, an IDE, Claude Desktop, and one Chat holds.
				const root = "D:\\CONG VIEC\\hoandat-app";
				const all = [
					{ sessionId: "5b1c0d2e-1111-4a6b-9c1d-000000000001", dir: `${root}\\chat-next`, title: "Thêm tab phiên có sẵn vào hộp thoại Phiên mới", updatedAt: BigInt(now - 40_000), messages: 46, entrypoint: "cli", threadId: "", busyElsewhere: true, sensitive: false },
					{ sessionId: "5b1c0d2e-1111-4a6b-9c1d-000000000002", dir: `${root}\\chat-next`, title: "Sửa giao diện Máy của tôi", updatedAt: BigInt(now - 25 * 60_000), messages: 18, entrypoint: "sdk-ts", threadId: DEMO_THREAD, busyElsewhere: false, sensitive: false },
					{ sessionId: "5b1c0d2e-1111-4a6b-9c1d-000000000003", dir: `${root}\\chat-next`, title: "Rà soát log deploy tối qua", updatedAt: BigInt(now - 5 * 3_600_000), messages: 9, entrypoint: "claude-desktop", threadId: "", busyElsewhere: false, sensitive: false },
					{ sessionId: "5b1c0d2e-1111-4a6b-9c1d-000000000004", dir: `${root}\\localman-next`, title: "Viết lại trình xem request của Localman cho màn hình hẹp", updatedAt: BigInt(now - 2 * 86_400_000), messages: 124, entrypoint: "cli", threadId: "", busyElsewhere: false, sensitive: false },
					{ sessionId: "5b1c0d2e-1111-4a6b-9c1d-000000000005", dir: "C:\\Users\\dieuvy", title: "Dọn file tải về", updatedAt: BigInt(now - 6 * 86_400_000), messages: 4, entrypoint: "cli", threadId: "", busyElsewhere: false, sensitive: true },
				];
				const { query, dir } = frame.body.value;
				const words = query.toLowerCase().split(/\s+/).filter(Boolean);
				const matching = all.filter((x) => words.every((w) => `${x.title} ${x.dir}`.toLowerCase().includes(w)));
				const dirs = [...new Set(matching.map((x) => x.dir))].map((d) => ({ dir: d, sessions: matching.filter((x) => x.dir === d).length }));
				const sessions = dir === "" ? matching : matching.filter((x) => x.dir === dir || x.dir.startsWith(`${dir}\\`));
				return [{ case: "sessionListResult", value: { sessions, total: sessions.length, dirs } }];
			}
			case "auditList":
				return [{ case: "auditListResult", value: { entries: [] } }];
			case "threadGitChanges":
				return [{ case: "gitChanges", value: { threadId: frame.body.value.threadId, git: true, files: gitFiles() } }];
			case "gitFileDiff": {
				const { threadId, path } = frame.body.value;
				const file = gitFiles().find((f) => f.path === path);
				if (file === undefined) return defaultAnswer(frame);
				const whole = file.truncated ? { ...file, truncated: false, unified: `${file.unified}\n+\n+Đã chụp lại ảnh 375 và 1440.` } : file;
				return [{ case: "gitFileDiffResult", value: { threadId, file: whole } }];
			}
			case "screenShareStatusRequest":
				return [{ case: "screenShareStatus", value: { supported: true, enabled: at !== "machine-screen-off", exposed: at === "machine-screen-signin", firewallOn: false } }];
			case "screenShareOpen": {
				const streamId = "demo-screen";
				rfb = new FakeRfb(at === "machine-screen-signin" ? 30 : 1, demoScreen(), (data) => machine.send(socket, { case: "screenShareData", value: { streamId, data: data.slice() } }));
				const started = rfb;
				setTimeout(() => started.start(), 0);
				return [{ case: "screenShareOpened", value: { streamId, idleMs: 600_000 } }];
			}
			case "screenShareData":
				rfb?.receive(frame.body.value.data);
				return [{ case: "ack", value: {} }];
			case "screenShareClose":
				rfb = null;
				return [{ case: "ack", value: {} }];
			case "browserClear":
				return [{ case: "ack", value: {} }];
			case "browserControl":
				return [{ case: "browserTakeover", value: { ...takeover, takeoverId: "demo-control", threadId: "", reason: "" } }];
			case "browserView": {
				const v = frame.body.value;
				if (!v.on) return [{ case: "ack", value: {} }];
				const shown = v.targetId === "" ? "T1" : v.targetId;
				setTimeout(() => {
					machine.send(socket, { case: "browserState", value: { takeoverId: v.takeoverId, tabs: browserTabs, targetId: shown, passwordFocused: shown === "T1" } });
					machine.send(socket, { case: "browserFrame", value: { takeoverId: v.takeoverId, targetId: shown, jpeg: browserPicture, pageWidth: 1200, pageHeight: 800 } });
				}, 0);
				return [{ case: "ack", value: {} }];
			}
			case "browserInput":
				return [{ case: "ack", value: {} }];
			case "browserTakeoverEnd":
				setTimeout(() => machine.send(socket, { case: "browserTakeoverEnded", value: { takeoverId: frame.body.case === "browserTakeoverEnd" ? frame.body.value.takeoverId : "" } }), 0);
				return [{ case: "ack", value: {} }];
			case "secretList":
				return [
					{
						case: "secretListResult",
						value: {
							secrets: [
								{ id: "s1", name: "API_TOKEN", origin: "https://api.staging.hoandat.io.vn", createdAt: BigInt(now - 86_400_000), lastUsedAt: 0n },
								{ id: "s2", name: "GITHUB_PASSWORD", origin: "https://github.com", createdAt: BigInt(now - 3 * 86_400_000), lastUsedAt: BigInt(now - 12 * 60_000) },
								{ id: "s3", name: "LOCALMAN_ADMIN", origin: "http://localhost:5173", createdAt: BigInt(now - 7 * 86_400_000), lastUsedAt: BigInt(now - 2 * 86_400_000) },
							],
						},
					},
				];
			case "attachmentUpload": {
				const v = frame.body.value;
				if (v.offset === 0n && v.name.startsWith("stall-")) stalled.set(v.uploadId, Math.floor(Number(v.size) * 0.4));
				const stop = stalled.get(v.uploadId);
				return stop !== undefined && Number(v.offset) + v.data.length > stop ? [] : [{ case: "ack", value: {} }];
			}
			case "projectList":
				return [projectList()];
			case "projectConfigSet": {
				// As tunelo: the folder's level, then the new project list and the session's level (it waits, so it is idle).
				const { dir, level } = frame.body.value;
				if (level === ProjectConfigLevel.FULL) configOn.add(dir);
				else configOn.delete(dir);
				if (dir === thread.dir) thread.projectConfig = levelOf(dir);
				setTimeout(() => {
					machine.send(socket, projectList());
					machine.send(socket, { case: "threadStatus", value: { thread } });
				}, 0);
				return [{ case: "projectConfig", value: { dir, level: levelOf(dir) } }];
			}
			case "threadSetArchived":
				return [{ case: "ack", value: {} }];
			case "attachmentCancel":
				return [{ case: "ack", value: {} }];
			case "attachmentFetch":
				return [{ case: "attachmentData", value: { threadId: frame.body.value.threadId, attachmentId: frame.body.value.attachmentId, mimeType: "image/png", data: image } }];
			default:
				return workspace.handle(frame) ?? usageSide.handle(frame) ?? terminalHost.handle(frame, socket) ?? defaultAnswer(frame);
		}
	};
	// The link opens `new WebSocket(TUNNEL)`: that one address goes to the fake machine.
	const Native = window.WebSocket;
	const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
		return String(url) === TUNNEL ? machine.factory(String(url)) : new Native(url, protocols);
	} as unknown as typeof WebSocket;
	Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = Patched;
	return ref;
}
