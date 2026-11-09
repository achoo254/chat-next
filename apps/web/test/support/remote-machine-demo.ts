// A paired machine for the visual harness: the real handshake and sealed
// frames (FakeMachine) behind the browser's WebSocket for one tunnel
// address, its key pinned in this browser, and a session with long shell
// commands, an answered and a pending permission prompt, a grouped run, a
// markdown answer (list, tasks, table, a code block wider than a phone),
// diffs of two files, and the statusline data (ThreadInfo) with commands and
// skills; the machine's Claude profiles announced unasked, the session
// switching account after its turn, a running session out of usage with a
// suggestion; previews; a running and a parked session in two folders; and beside it a
// machine this browser has not paired with and one that is offline.
// Test-only: never part of the production build.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Decision, ItemSchema, PromptState, Role, ThreadState, ToolKind, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { brand } from "../../src/brand.ts";
import { deviceKeyStore } from "../../src/machines/link/device-keys.ts";
import { defaultAnswer, FakeMachine } from "../machines/fake-machine.ts";
import type { FakeMachines } from "./fake-machines.ts";

export const DEMO_THREAD = "demo-thread";
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
		item("u1", { case: "text", value: { role: Role.USER, text: "Chạy test của màn Máy của tôi rồi sửa chỗ lỗi giúp mình" } }),
		item("turn1", { case: "turn", value: { state: TurnState.COMPLETED, durationMs: 42_300n, contextTokens: 68_000n, contextWindow: 200_000n } }),
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
		item("u2", { case: "text", value: { role: Role.USER, text: "Ok, build lại luôn nhé" } }),
		item("turn2", { case: "turn", value: { state: TurnState.RUNNING } }),
		item("a2", { case: "text", value: { role: Role.ASSISTANT, text: "Mình xoá thư mục build cũ rồi chạy lại." } }),
		item("t5", bash("5", "rm -rf apps/web/dist apps/web/test/visual/dist && pnpm --filter @app/web build")),
		item("p5", { case: "approval", value: { toolId: "5", kind: ToolKind.SHELL, name: "Bash", summary: "rm -rf apps/web/dist apps/web/test/visual/dist && pnpm --filter @app/web build", reason: "Xoá thư mục build", state: PromptState.PENDING } }),
	];
}

/** Adds the machine to `machines`, pins its key here and answers its link; resolves with its ref. */
export async function installRemoteMachineDemo(machines: FakeMachines): Promise<string> {
	const now = Date.now();
	const machine = await FakeMachine.create();
	const keys = deviceKeyStore();
	const device = await keys.device();
	machine.paired = [device.publicKey];
	const entry = machines.add({ name: "DIEUVY-LAPTOP", os: "win32", arch: "x64", tunnelUrl: TUNNEL, lastSeenAt: BigInt(Math.floor(now / 1000)), agentVersion: "2.0.1" });
	const ref = String(entry.id);
	await keys.pin(ref, machine.keys.publicKey);
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
	};
	const others = [
		{ id: "demo-running", title: "Viết test cho bảng Cần bạn", dir: "D:\\CONG VIEC\\hoandat-app\\chat-next", provider: "claude", model: "sonnet", state: ThreadState.RUNNING, pending: 0, updatedAt: BigInt(now - 60_000), open: true, preview: "", previewTool: "Bash" },
		{ id: "demo-idle", title: "Rà soát quyền MCP của tunelo", dir: "D:\\CONG VIEC\\hoandat-app\\localman-next", provider: "claude", model: "opus", state: ThreadState.IDLE, pending: 0, updatedAt: BigInt(now - 3 * 3_600_000), open: false, preview: "Đã rà 12 tool MCP: tool ghi đều hỏi lại, tool đọc chạy thẳng.", previewTool: "" },
	];
	// A machine this browser has not paired with, and one that went offline.
	machines.add({ name: "Mac mini", os: "darwin", arch: "arm64", tunnelUrl: `wss://other.tunnel.${brand.domain}`, lastSeenAt: BigInt(Math.floor(now / 1000)), agentVersion: "2.0.1" });
	machines.add({ name: "Máy nhà", os: "linux", arch: "x64", tunnelUrl: "", lastSeenAt: BigInt(Math.floor(now / 1000) - 2 * 3600), agentVersion: "2.0.1" });
	const usage = (five: number, week: number) => ({ fiveHour: { utilization: five, resetsAt: BigInt(now + 3_600_000) }, sevenDay: { utilization: week, resetsAt: BigInt(now + 3 * 86_400_000) } });
	const profiles = {
		selectedId: "p2",
		profiles: [
			{ id: "", email: "dieuvy@inet.vn", organization: "iNET", plan: "team", signedIn: true, lastUsage: usage(100, 64), usageUpdatedAt: BigInt(now - 120_000) },
			{ id: "p2", email: "dieuvy.max@gmail.com", plan: "max", signedIn: true, lastUsage: usage(4, 80), usageUpdatedAt: BigInt(now - 60_000) },
			{ id: "p3", email: "dieuvy.pro@gmail.com", plan: "pro", signedIn: false },
		],
	};
	machine.handler = (frame, socket) => {
		switch (frame.body.case) {
			case "profileList":
			case "profileSelect":
				return [{ case: "profileListResult", value: profiles }];
			case "machineInfoRequest":
				// The machine announces its profiles unasked (id "") to every device.
				setTimeout(
					() =>
						machine.send(socket, {
							case: "machineProfile",
							value: {
								profiles,
								sessions: [
									{ threadId: DEMO_THREAD, profileId: "", switchPending: true },
									{ threadId: "demo-running", profileId: "", switchPending: false },
									{ threadId: "demo-idle", profileId: "p2", switchPending: false },
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
							agentVersion: "2.0.1",
							maxSessions: 3,
							openSessions: 1,
							providers: [{ id: "claude", name: "Claude Code", version: "2.1.0", capabilities: { sessionAllow: true, models: [{ id: "opus", name: "Opus 4.7" }, { id: "sonnet", name: "Sonnet 4.6" }] } }],
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
								profileId: "",
								machineProfileId: "p2",
								account: { email: "dieuvy@inet.vn", organization: "iNET", plan: "team" },
								profileSwitchPending: threadId === DEMO_THREAD,
								...(threadId === DEMO_THREAD ? { nextAccount: { email: "dieuvy.max@gmail.com", plan: "max" } } : {}),
								...(threadId === "demo-running" ? { profileSuggestion: { profileId: "p2", email: "dieuvy.max@gmail.com", remaining: 20 } } : {}),
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
			default:
				return defaultAnswer(frame);
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
