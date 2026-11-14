// The dock's "+" menu as data: its groups in order, what is disabled and
// why, the known AIs against what the machine reports, and the search over
// labels and folders (case and Vietnamese accents aside).
import { create } from "@bufbuild/protobuf";
import { LoginState, MachineInfoSchema, TermSessionInfoSchema, TerminalAvailability, type MachineInfo, type TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { agentChoices, buildNewTabActions, filterNewTabActions, groupNewTabActions, type AgentChoice, type NewTabInput } from "../../src/terminal/new-tab-actions.ts";

const t = viMachines.terminal;

function session(over: MessageInitShape<typeof TermSessionInfoSchema>): TermSessionInfo {
	return create(TermSessionInfoSchema, { session: 1, cwd: "", title: "", threadId: "", ...over });
}

function input(over: Partial<NewTabInput> = {}): NewTabInput {
	return {
		t,
		prefix: "Alt+Shift+",
		busy: false,
		startingAgent: false,
		noFolder: false,
		agents: [],
		hidden: [],
		now: Date.now(),
		onNewTab: () => undefined,
		onStartAgent: () => undefined,
		onReopen: () => undefined,
		...over,
	};
}

const READY: AgentChoice = { id: "claude", name: "Claude Code", icon: "run-claude", availability: "ready" };
const MISSING: AgentChoice = { id: "antigravity", name: "Antigravity", icon: "run-antigravity", availability: "not-installed" };

describe("buildNewTabActions", () => {
	it("puts the new terminal first, then the AIs, then the machine's sessions, each group once", () => {
		const actions = buildNewTabActions(input({ agents: [READY, MISSING], hidden: [session({ session: 4, cwd: "/w/app", title: "vim" })] }));
		expect(groupNewTabActions(actions).map((g) => g.id)).toEqual(["terminal", "agent", "session"]);
		expect(actions.map((a) => a.id)).toEqual(["new-terminal", "agent:claude", "agent:antigravity", "session:4"]);
		expect(actions[0]).toMatchObject({ label: "Terminal mới", shortcut: "Alt+Shift+T", disabled: false });
	});

	it("leaves out the groups with nothing in them", () => {
		expect(groupNewTabActions(buildNewTabActions(input())).map((g) => g.id)).toEqual(["terminal"]);
	});

	it("greys out an AI the machine cannot start in the terminal, with why, and everything new while busy", () => {
		const notInTerminal: AgentChoice = { ...READY, id: "x", availability: "not-in-terminal" };
		const [, ready, missing, noTerm] = buildNewTabActions(input({ agents: [READY, MISSING, notInTerminal] }));
		expect(ready).toMatchObject({ disabled: false });
		expect(ready?.hint).toBeUndefined();
		expect(missing).toMatchObject({ disabled: true, hint: "Chưa cài" });
		expect(noTerm).toMatchObject({ disabled: true, hint: "Chưa dùng được trong terminal" });
		const signedOut: AgentChoice = { ...READY, id: "y", availability: "needs-login" };
		expect(buildNewTabActions(input({ agents: [signedOut] }))[1]).toMatchObject({ disabled: true, hint: "Cần đăng nhập" });
		// Offline or a terminal opening: nothing new, and no session to reopen either (Enter in the search included).
		const busy = buildNewTabActions(input({ busy: true, agents: [READY], hidden: [session({})] }));
		expect(busy.map((a) => a.disabled === true)).toEqual([true, true, true]);
	});

	it("greys out the AIs while one starts, and on the machine's own dock where there is no folder for them", () => {
		const starting = buildNewTabActions(input({ startingAgent: true, agents: [READY], hidden: [session({})] }));
		expect(starting.map((a) => a.disabled === true)).toEqual([false, true, false]);
		const [, ready, missing] = buildNewTabActions(input({ noFolder: true, agents: [READY, MISSING] }));
		expect(ready).toMatchObject({ disabled: true, hint: "Mở trong một dự án để chạy agent" });
		// What is wrong with the AI itself says more than the folder.
		expect(missing).toMatchObject({ disabled: true, hint: "Chưa cài" });
	});

	it("runs the callback each entry names", () => {
		const onNewTab = vi.fn();
		const onStartAgent = vi.fn();
		const onReopen = vi.fn();
		const actions = buildNewTabActions(input({ agents: [READY], hidden: [session({ session: 7 })], onNewTab, onStartAgent, onReopen }));
		for (const a of actions) a.run();
		expect(onNewTab).toHaveBeenCalledOnce();
		expect(onStartAgent).toHaveBeenCalledWith("claude");
		expect(onReopen).toHaveBeenCalledWith(7);
	});

	it("describes a session as the old list did: its title or kind, folder, opened time and state", () => {
		const now = new Date(2026, 10, 14, 18, 0).getTime();
		const opened = BigInt(new Date(2026, 10, 14, 9, 5).getTime());
		const [, shell, ai] = buildNewTabActions(
			input({ now, hidden: [session({ session: 2, cwd: "/w/app", createdAt: opened }), session({ session: 3, threadId: "t1", attached: true })] }),
		);
		expect(shell).toMatchObject({ label: "Shell", icon: "terminal", title: "/w/app" });
		expect(shell?.hint).toMatch(/^app · mở lúc .*09.05.* · Đang chạy$/);
		expect(ai).toMatchObject({ label: "Phiên AI", icon: "ai-session", hint: "Đang mở ở nơi khác" });
	});
});

describe("filterNewTabActions", () => {
	const actions = buildNewTabActions(
		input({ agents: [READY, MISSING], hidden: [session({ session: 2, cwd: "/Users/me/Dự án/chat-next", title: "dev server" }), session({ session: 3, cwd: "/w/other" })] }),
	);
	const ids = (query: string) => filterNewTabActions(actions, query).map((a) => a.id);

	it("keeps everything for an empty query", () => {
		expect(ids("  ")).toHaveLength(actions.length);
	});

	it("matches labels without regard to case or Vietnamese accents", () => {
		expect(ids("TERMINAL MOI")).toEqual(["new-terminal"]);
		expect(ids("claude")).toEqual(["agent:claude"]);
	});

	it("matches a session by its folder name or full path, every word", () => {
		expect(ids("chat-next")).toEqual(["session:2"]);
		expect(ids("du an")).toEqual(["session:2"]);
		expect(ids("dev other")).toEqual([]);
	});

	it("matches the hint, so a not installed AI can be found by it", () => {
		expect(ids("chua cai")).toEqual(["agent:antigravity"]);
	});
});

describe("agentChoices", () => {
	const info = (terminal: TerminalAvailability, ...providers: { id: string; name: string; terminal: boolean; signedOut?: boolean }[]): MachineInfo =>
		create(MachineInfoSchema, {
			name: "Mac",
			terminal,
			providers: providers.map((p) => ({ id: p.id, name: p.name, loginState: p.signedOut === true ? LoginState.NEEDS_LOGIN : LoginState.OK, capabilities: { terminal: p.terminal } })),
		});
	const availability = (choices: readonly AgentChoice[]) => choices.map((a) => [a.id, a.availability]);

	it("lists every known AI, none installed while the machine has not said", () => {
		expect(availability(agentChoices(null))).toEqual([
			["claude", "not-installed"],
			["antigravity", "not-installed"],
		]);
	});

	it("is ready only when the machine has the AI and offers it in the terminal", () => {
		const machine = info(TerminalAvailability.AVAILABLE, { id: "claude", name: "Claude Code", terminal: true }, { id: "antigravity", name: "Antigravity", terminal: false });
		expect(availability(agentChoices(machine))).toEqual([
			["claude", "ready"],
			["antigravity", "not-in-terminal"],
		]);
		// A machine without its terminal part offers no AI there.
		expect(availability(agentChoices(info(TerminalAvailability.MISSING, { id: "claude", name: "Claude Code", terminal: true })))).toEqual([
			["claude", "not-in-terminal"],
			["antigravity", "not-installed"],
		]);
	});

	it("an AI the machine lists signed out needs a sign-in, not a start", () => {
		expect(availability(agentChoices(info(TerminalAvailability.AVAILABLE, { id: "claude", name: "Claude Code", terminal: true, signedOut: true })))[0]).toEqual(["claude", "needs-login"]);
	});

	it("takes the machine's own name for an AI", () => {
		expect(agentChoices(info(TerminalAvailability.AVAILABLE, { id: "claude", name: "Claude Code (beta)", terminal: true }))[0]?.name).toBe("Claude Code (beta)");
	});
});
