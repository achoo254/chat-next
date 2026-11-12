// A session running a turn elsewhere on the machine (a terminal, an IDE)
// shows under "Đang chạy" with its own wording, and the line under the last
// message tells what a running turn does (phase, time, output tokens). The
// clock of that line ticks alone: neither the messages nor the session list
// render again for it.
import { create } from "@bufbuild/protobuf";
import { ActivityPhase, ThreadActivitySchema, ThreadState, ThreadSummarySchema, type ThreadActivity, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair } from "@achoo254/chat-remote-protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ActivityLine, tokenCount, type ActivitySource } from "../../src/machines/activity-line.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { MachineLink, sortForList, type LinkState } from "../../src/machines/link/machine-link.ts";
import { Transcript } from "../../src/machines/session-chat.tsx";
import { matches, rowLine } from "../../src/machines/session-sidebar.tsx";
import type { Block } from "../../src/machines/transcript/tool-fold.ts";
import { isRunning, stateKey } from "../../src/machines/use-machines.ts";
import { FakeMachine, until } from "./fake-machine.ts";

// Counts how often the messages render, around the real component.
const textRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/machines/rich/agent-text.tsx", async (original) => {
	const real = await original<typeof import("../../src/machines/rich/agent-text.tsx")>();
	return {
		...real,
		AgentText: (props: Parameters<typeof real.AgentText>[0]) => {
			textRenders.count += 1;
			return real.AgentText(props);
		},
	};
});

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const summary = (over: Omit<Partial<ThreadSummary>, "$typeName" | "$unknown"> = {}): ThreadSummary =>
	create(ThreadSummarySchema, { id: "t1", title: "Build", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: 1n, ...over });

/** An activity source the test sets by hand. */
function manualSource(): ActivitySource & { set(a: ThreadActivity | undefined): void } {
	let current: ThreadActivity | undefined;
	const listeners = new Set<() => void>();
	return {
		activity: () => current,
		onActivity: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(a) {
			current = a;
			for (const l of listeners) l();
		},
	};
}

describe("a session running elsewhere in the session column", () => {
	it("is under the attention switch, as busy elsewhere; without the field it stays idle as before", () => {
		const elsewhere = { state: ThreadState.IDLE, archived: false, busyElsewhere: true };
		expect(matches("attention", elsewhere)).toBe(true);
		expect(matches("all", elsewhere)).toBe(true);
		expect(stateKey(elsewhere)).toBe("elsewhere");
		expect(isRunning(elsewhere)).toBe(true);
		// An older machine never sends the field.
		const older = { state: ThreadState.IDLE, archived: false };
		expect(matches("attention", older)).toBe(false);
		expect(stateKey(older)).toBe("idle");
		expect(stateKey({ state: ThreadState.RUNNING })).toBe("running");
		// Waiting for the user wins over anything else.
		expect(stateKey({ state: ThreadState.WAITING, busyElsewhere: true })).toBe("waiting");
	});

	it("counts in the running tab with running and queued sessions", () => {
		const threads = [
			{ state: ThreadState.RUNNING, archived: false },
			{ state: ThreadState.QUEUED, archived: false },
			{ state: ThreadState.IDLE, archived: false, busyElsewhere: true },
			{ state: ThreadState.IDLE, archived: false, busyElsewhere: false },
			{ state: ThreadState.IDLE, archived: false },
			{ state: ThreadState.WAITING, archived: false },
		];
		expect(threads.filter((x) => isRunning(x)).length).toBe(3);
		expect(viMachines.sessions.running(3)).toBe("Đang chạy (3)");
		expect(viMachines.sessions.running(0)).toBe("Đang chạy");
		expect(enMachines.sessions.running(2)).toBe("Running (2)");
		expect(zhCNMachines.sessions.running(2)).toBe("运行中（2）");
	});

	it("shows the tool running there as its line, and sorts with the running sessions", () => {
		const there = summary({ id: "e", busyElsewhere: true, previewTool: "Bash", preview: "On it.", updatedAt: 1n });
		expect(rowLine(viMachines, there, null)).toBe("Đang chạy: Bash");
		expect(rowLine(viMachines, summary({ preview: "On it." }), null)).toBe("On it.");
		const idle = summary({ id: "i", updatedAt: 5n });
		expect(sortForList([idle, there]).map((x) => x.id)).toEqual(["e", "i"]);
	});

	it("words the chip and the header in every language, with no product name", () => {
		const words = (c: typeof viMachines) => [c.chat.chip.elsewhere, c.sessions.state.elsewhere, c.transcript.activity.elsewhere];
		expect(words(viMachines)).toEqual(["Đang mở ngoài app", "Đang mở ngoài app", "Đang mở ngoài app"]);
		expect(words(enMachines)).toEqual(["Open outside the app", "Open outside the app", "Open outside the app"]);
		expect(words(zhCNMachines)).toEqual(["在应用外打开", "在应用外打开", "在应用外打开"]);
		for (const c of [viMachines, enMachines, zhCNMachines]) {
			const all = [...words(c), c.transcript.activity.thinking, c.transcript.activity.writing, c.transcript.activity.waiting, c.transcript.activity.tool("X"), c.transcript.activity.lastActive("1"), c.transcript.activity.tokens("1")];
			for (const text of all) expect(text).not.toMatch(/claude|anthropic|tunelo/i);
		}
	});
});

describe("the activity line", () => {
	const NOW = Date.parse("2026-11-11T08:00:00.000Z");

	function line(props: Partial<Parameters<typeof ActivityLine>[0]> & { source: ActivitySource }) {
		return wrap(<ActivityLine threadId="t1" thread={summary({ state: ThreadState.RUNNING })} running live startedAt={NOW - 65_000} waiting={false} streaming={false} ai="Claude Code" {...props} />);
	}

	it("says the phase, the turn's time and the output tokens when the machine reports them", () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const source = manualSource();
		source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.TOOL, tool: "Bash", turnStartedAt: BigInt(NOW - 65_000), outputTokens: 8_700n }));
		line({ source });
		expect(screen.getByRole("status").textContent).toBe(`Đang chạy Bash · 1 phút 5 giây · ↓ ${tokenCount(8_700n, "vi")} token`);
		// No count when the AI does not report one (absent, not zero).
		act(() => source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.WRITING, turnStartedAt: BigInt(NOW - 65_000) })));
		expect(screen.getByRole("status").textContent).toBe("Đang viết · 1 phút 5 giây");
		act(() => source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.WAITING, turnStartedAt: BigInt(NOW - 65_000), outputTokens: 0n })));
		expect(screen.getByRole("status").textContent).toBe("Đang chờ bạn · 1 phút 5 giây · ↓ 0 token");
	});

	it("thinks until the first activity arrives, timed from the turn in the transcript; an earlier turn's activity is ignored", () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const source = manualSource();
		source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.TOOL, tool: "Bash", turnStartedAt: BigInt(NOW - 600_000), outputTokens: 5n }));
		line({ source, startedAt: NOW - 3_000 });
		expect(screen.getByRole("status").textContent).toBe("Đang suy nghĩ · 3 giây");
	});

	it("shows only what the machine can tell of a session running elsewhere: its tool and its last activity", () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const source = manualSource();
		const thread = summary({ busyElsewhere: true, previewTool: "Bash", elsewhereActiveAt: BigInt(NOW - 12_000) });
		line({ source, thread, running: false, startedAt: null });
		expect(screen.getByRole("status").textContent).toBe("Đang mở ngoài app · Đang chạy Bash · hoạt động 12 giây trước");
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(screen.getByRole("status").textContent).toBe("Đang mở ngoài app · Đang chạy Bash · hoạt động 15 giây trước");
	});

	it("keeps the plain working line for machines before the activity, hidden while the answer streams", () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const source = manualSource();
		const { unmount } = line({ source, live: false, startedAt: NOW - 4_000 });
		expect(screen.getByRole("status").textContent).toBe("Đang làm việc · 4 giây");
		unmount();
		line({ source, live: false, streaming: true });
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows nothing when nothing runs here or elsewhere", () => {
		line({ source: manualSource(), running: false, thread: summary() });
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("ticks every second without rendering the messages again", () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const source = manualSource();
		source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.THINKING, turnStartedAt: BigInt(NOW - 5_000), outputTokens: 10n }));
		const blocks: Block[] = [
			{ kind: "user", id: "u1", text: "build it", pending: false, attachments: [] },
			{ kind: "text", id: "a1", text: "On it.", partial: false },
			{ kind: "text", id: "a2", text: "Running the build.", partial: false },
		];
		const state = { info: null, full: new Map(), journals: new Map(), threads: [] } as unknown as LinkState;
		const link = { ...source, request: () => Promise.reject(new Error("not used")) };
		wrap(<Transcript blocks={blocks} state={state} running startedAt={NOW - 5_000} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={summary({ state: ThreadState.RUNNING })} live />);
		act(() => {
			vi.advanceTimersByTime(0);
		});
		const rendered = textRenders.count;
		expect(rendered).toBeGreaterThanOrEqual(2);
		expect(screen.getByRole("status").textContent).toContain("5 giây");
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(screen.getByRole("status").textContent).toContain("8 giây");
		// New activity from the machine: the line again, not the messages.
		act(() => source.set(create(ThreadActivitySchema, { threadId: "t1", phase: ActivityPhase.WRITING, turnStartedAt: BigInt(NOW - 5_000), outputTokens: 50n })));
		expect(screen.getByRole("status").textContent).toContain("Đang viết");
		expect(textRenders.count).toBe(rendered);
	});
});

describe("activity frames on the machine's link", () => {
	it("are kept for the activity line without changing the link's state, so the session list does not render again", async () => {
		const machine = await FakeMachine.create();
		const device = await generateKeyPair();
		machine.paired = [device.publicKey];
		const link = new MachineLink({
			device: () => Promise.resolve(device),
			deviceName: "test",
			pinned: () => Promise.resolve(machine.keys.publicKey),
			tunnelUrl: () => "wss://abc.tunnel.hoandat.com",
			refreshTunnel: () => Promise.resolve("wss://abc.tunnel.hoandat.com"),
			socket: machine.factory,
			// Timeouts at once, no pings: only the frames this test sends.
			timers: { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), setInterval: () => 0, clearInterval: () => undefined, now: () => Date.now() },
			random: () => 0,
		});
		link.start();
		await until(() => link.snapshot().status.kind === "open", "open");
		await until(() => link.snapshot().listed, "listed");

		let listRenders = 0;
		function SessionList() {
			const state = useSyncExternalStore(link.subscribe, link.snapshot);
			return <p>{state.threads.length} sessions</p>;
		}
		wrap(
			<>
				<Profiler id="list" onRender={() => (listRenders += 1)}>
					<SessionList />
				</Profiler>
				<ActivityLine source={link} threadId="t1" thread={summary({ state: ThreadState.RUNNING })} running live startedAt={null} waiting={false} streaming={false} ai="AI" />
			</>,
		);
		const before = listRenders;
		for (let i = 1; i <= 5; i++) {
			machine.send(machine.socket, { case: "threadActivity", value: { threadId: "t1", phase: ActivityPhase.TOOL, tool: "Bash", turnStartedAt: BigInt(Date.now() - 1_000), outputTokens: BigInt(i * 100) } });
			await until(() => link.activity("t1")?.outputTokens === BigInt(i * 100), `activity ${i}`);
		}
		await until(() => (screen.getByRole("status").textContent ?? "").includes("Đang chạy Bash"), "the line");
		expect(listRenders).toBe(before);
		// A deleted thread drops its activity too.
		machine.send(machine.socket, { case: "threadDeleted", value: { threadId: "t1", trashed: 0 } });
		await until(() => link.activity("t1") === undefined, "dropped");
		link.stop();
	});
});
