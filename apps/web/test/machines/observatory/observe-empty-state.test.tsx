// A thread's Observe view with no recorded session: which of the three views
// it gets (no conversation yet, a session opened before Observatory was on,
// a session running elsewhere on the machine), the "reopen" button (locked
// while a turn runs or the session runs elsewhere, asking first for the
// terminal, saying what was done or why it failed), and the view asking the
// thread's sessions again once reopened, for a bounded while, without a
// second reopen). A turn in tunelo's own terminal is the thread's own. A
// thread that is not Claude Code's (no thread given) and an older tunelo keep
// their views.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, MachineInfoSchema, ObservatorySessionInfoSchema, ObservatorySessionListResultSchema } from "@achoo254/chat-proto/remote/remote";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import { vi as viMessaging } from "../../../src/messaging/copy/vi.ts";
import { enMachines } from "../../../src/machines/copy-en.ts";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../../src/machines/copy-zh-CN.ts";
import { RemoteError } from "../../../src/machines/link/machine-link.ts";
import LiveMapView, { REOPEN_ASK_MS, REOPEN_ASKS } from "../../../src/machines/observatory/live-map-view.tsx";
import { relaunchFactsOf } from "../../../src/machines/observatory/relaunch-session.ts";
import { emptyStateOf, ObserveEmptyState, type EmptyStateKind, type ObserveThread, type RelaunchAction } from "../../../src/machines/observatory/observe-empty-state.tsx";
import { FakeLink } from "./fake-observatory-link.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const t = viMachines.observe.empty;
const thread = (preview: string, running = false, busyElsewhere = false): ObserveThread => ({ preview, running, busyElsewhere });
const relaunchOf = (kind: RelaunchAction["kind"], run: () => Promise<void>, blocked?: string): RelaunchAction => ({ kind, run, ...(blocked === undefined ? {} : { blocked }) });

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	});
};

describe("which empty view a thread gets", () => {
	const table: [string, ObserveThread | undefined, EmptyStateKind][] = [
		["no thread known", undefined, "never"],
		["no conversation, idle", thread(""), "never"],
		["no conversation, its first turn running (recorded from its start)", thread("", true), "never"],
		["a conversation, idle", thread("ok, done"), "notRecorded"],
		["a conversation, a turn running", thread("ok, done", true), "notRecorded"],
		["running elsewhere on the machine", thread("ok, done", false, true), "elsewhere"],
		["running elsewhere, no line here yet", thread("", false, true), "elsewhere"],
	];
	it.each(table)("%s", (_name, input, kind) => {
		expect(emptyStateOf(input)).toBe(kind);
	});

	// The page's facts: (preview, busy elsewhere, terminal session, a turn running in chat) -> view, reopen kind, locked.
	const facts: [string, string, boolean, number, boolean, EmptyStateKind, "terminal" | "chat", boolean][] = [
		["chat, idle", "hi", false, 0, false, "notRecorded", "chat", false],
		["chat, a turn running", "hi", false, 0, true, "notRecorded", "chat", true],
		["chat, the session busy elsewhere on the machine", "hi", true, 0, false, "elsewhere", "chat", false],
		["terminal, idle", "hi", false, 7, false, "notRecorded", "terminal", false],
		["terminal, a turn running inside the machine's own terminal", "hi", true, 7, false, "notRecorded", "terminal", true],
		["terminal, its first turn running inside it", "", true, 7, false, "never", "terminal", true],
	];
	it.each(facts)("%s", (_name, preview, busyElsewhere, terminalSession, running, kind, how, busy) => {
		const got = relaunchFactsOf({ preview, busyElsewhere, terminalSession }, running);
		expect(emptyStateOf(got.thread)).toBe(kind);
		expect(got.kind).toBe(how);
		expect(got.busy).toBe(busy);
	});
});

describe("the empty view", () => {
	it("says how to start when the thread has had no conversation, with nothing to reopen", () => {
		wrap(<ObserveEmptyState thread={thread("")} relaunch={relaunchOf("chat", vi.fn())} reopened={null} onReopened={vi.fn()} />);
		expect(screen.getByText(t.never)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.relaunch })).toBeNull();
	});

	it("reopens a chat session at once and says the next message records it", async () => {
		const run = vi.fn(() => Promise.resolve());
		const onReopened = vi.fn();
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={relaunchOf("chat", run)} reopened={null} onReopened={onReopened} />);
		expect(screen.getByText(t.notRecorded)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: t.relaunch }));
		expect(run).toHaveBeenCalledTimes(1);
		expect(onReopened).toHaveBeenCalledWith("chat");
		// No dialog for chat.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks before reopening the terminal, and does nothing when cancelled", async () => {
		const run = vi.fn(() => Promise.resolve());
		const onReopened = vi.fn();
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={relaunchOf("terminal", run)} reopened={null} onReopened={onReopened} />);
		await userEvent.click(screen.getByRole("button", { name: t.relaunch }));
		expect(screen.getByText(t.confirmBody)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: viMessaging.common.cancel }));
		expect(run).not.toHaveBeenCalled();
		expect(onReopened).not.toHaveBeenCalled();
		expect(screen.queryByText(t.confirmBody)).toBeNull();
	});

	it("reopens the terminal once confirmed", async () => {
		const run = vi.fn(() => Promise.resolve());
		const onReopened = vi.fn();
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={relaunchOf("terminal", run)} reopened={null} onReopened={onReopened} />);
		await userEvent.click(screen.getByRole("button", { name: t.relaunch }));
		await userEvent.click(screen.getByRole("button", { name: t.confirm }));
		expect(run).toHaveBeenCalledTimes(1);
		expect(onReopened).toHaveBeenCalledWith("terminal");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("locks the button while a turn runs and says why", () => {
		wrap(<ObserveEmptyState thread={thread("hi", true)} relaunch={relaunchOf("chat", vi.fn(), t.blockedRunning)} reopened={null} onReopened={vi.fn()} />);
		expect(screen.getByRole("button", { name: t.relaunch }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByText(t.blockedRunning)).toBeTruthy();
	});

	it("locks the button for a session running elsewhere and names the command", () => {
		const view = wrap(<ObserveEmptyState thread={thread("hi", false, true)} relaunch={relaunchOf("chat", vi.fn())} reopened={null} onReopened={vi.fn()} />);
		expect(screen.getByText(t.notRecorded)).toBeTruthy();
		expect(screen.getByRole("button", { name: t.relaunch }).hasAttribute("disabled")).toBe(true);
		expect(view.container.querySelector("[data-id=observe-elsewhere] code")?.textContent).toBe("tunelo observatory install");
	});

	it("says why the machine refused, and stays open to try again", async () => {
		const run = vi.fn(() => Promise.reject(new RemoteError(ErrorCode.INVALID, "running", ErrorReason.THREAD_RUNNING)));
		const onReopened = vi.fn();
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={relaunchOf("chat", run)} reopened={null} onReopened={onReopened} />);
		await userEvent.click(screen.getByRole("button", { name: t.relaunch }));
		expect(screen.getByRole("alert").textContent).toBe(t.errorRunning);
		expect(onReopened).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: t.relaunch }).hasAttribute("disabled")).toBe(false);
	});

	it("offers no second reopen once the session was reopened", () => {
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={relaunchOf("terminal", vi.fn())} reopened="terminal" onReopened={vi.fn()} />);
		expect(screen.getByText(t.doneTerminal)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.relaunch })).toBeNull();
	});

	it("shows no button where the page offers no reopening", () => {
		wrap(<ObserveEmptyState thread={thread("hi")} relaunch={undefined} reopened={null} onReopened={vi.fn()} />);
		expect(screen.getByText(t.notRecorded)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("has every line in every language", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			expect(Object.keys(copy.observe.empty).sort()).toEqual(Object.keys(t).sort());
			const lines = Object.values(copy.observe.empty).map((line) => (typeof line === "string" ? line : line("x")));
			expect(lines.filter((line) => line.trim() === "")).toEqual([]);
		}
	});
});

describe("the Observe tab of a thread with no recorded session", () => {
	const info = create(MachineInfoSchema, { agentVersion: "3.26.0" });
	const noSessions = { case: "observatorySessionListResult", value: create(ObservatorySessionListResultSchema, {}) } as const;

	afterEach(() => {
		vi.useRealTimers();
	});

	const lists = (fake: FakeLink): number => fake.sent.filter((b) => b.case === "observatorySessionList").length;

	it("offers to reopen, then asks the thread's sessions again for a while, keeping the view, until one shows", async () => {
		vi.useFakeTimers();
		const fake = new FakeLink();
		const run = vi.fn(() => Promise.resolve());
		const view = wrap(<LiveMapView link={fake.link} machine="1" info={info} online target={{ kind: "thread", threadId: "t1" }} thread={thread("hi")} relaunch={relaunchOf("chat", run)} />);
		fake.answer(noSessions);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: t.relaunch }));
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		// Asked again at once; the empty view stays while asked, with what was done and no second reopen.
		expect(lists(fake)).toBe(2);
		expect(screen.getByText(t.doneChat)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.relaunch })).toBeNull();
		fake.answer(noSessions);
		await flush();
		// Then every REOPEN_ASK_MS.
		await act(async () => {
			vi.advanceTimersByTime(REOPEN_ASK_MS);
		});
		expect(lists(fake)).toBe(3);
		expect(view.container.querySelector("[data-id=observe-empty]")).toBeTruthy();
		// The recorded session shows: the map opens and nothing more is asked.
		fake.answer({ case: "observatorySessionListResult", value: create(ObservatorySessionListResultSchema, { sessions: [create(ObservatorySessionInfoSchema, { sessionId: "s1" })] }) });
		await flush();
		expect(fake.sent.at(-1)).toEqual({ case: "observatoryWatch", value: { sessionId: "s1", on: true, limit: 500 } });
		const asked = lists(fake);
		await act(async () => {
			vi.advanceTimersByTime(REOPEN_ASK_MS * 3);
		});
		expect(lists(fake)).toBe(asked);
	});

	it("stops asking after REOPEN_ASKS rounds when no session shows", async () => {
		vi.useFakeTimers();
		const fake = new FakeLink();
		wrap(<LiveMapView link={fake.link} machine="1" info={info} online target={{ kind: "thread", threadId: "t1" }} thread={thread("hi")} relaunch={relaunchOf("chat", () => Promise.resolve())} />);
		fake.answer(noSessions);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: t.relaunch }));
		await flush();
		for (let i = 0; i < REOPEN_ASKS + 3; i++) {
			fake.answer(noSessions);
			await flush();
			await act(async () => {
				vi.advanceTimersByTime(REOPEN_ASK_MS);
			});
		}
		// The first ask, the one right after reopening, and REOPEN_ASKS more.
		expect(lists(fake)).toBe(2 + REOPEN_ASKS);
	});

	it("keeps the update note on an older tunelo", () => {
		const fake = new FakeLink();
		wrap(
			<LiveMapView
				link={fake.link}
				machine="1"
				info={create(MachineInfoSchema, { agentVersion: "3.25.0" })}
				online
				target={{ kind: "thread", threadId: "t1" }}
				thread={thread("hi")}
				relaunch={relaunchOf("chat", vi.fn())}
			/>,
		);
		expect(screen.getByText(viMachines.observe.needsUpdate)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.relaunch })).toBeNull();
		expect(fake.sent).toEqual([]);
	});
});
