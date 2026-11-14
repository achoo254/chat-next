// The machine page's list of terminal sessions: what it shows of each, the
// order, and the TermClose requests its buttons send (one, after asking; all
// the unwatched ones; an exited one dropped at once). Also the menu's
// in-place stop button.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, FrameSchema, TermSessionInfoSchema, ThreadState, ThreadSummarySchema, type Frame, type TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError } from "../../src/machines/link/machine-link.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { MachineTerminalSessions, sortTermSessions, termState } from "../../src/machines/machine-terminal-sessions.tsx";
import { StopSessionButton } from "../../src/terminal/stop-session-button.tsx";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

const term = (over: MessageInitShape<typeof TermSessionInfoSchema>): TermSessionInfo => create(TermSessionInfoSchema, { session: 1, title: "", threadId: "", cwd: "", ...over });

const SESSIONS = [
	term({ session: 1, title: "bash", cwd: "/w/app", createdAt: 1_000n }),
	term({ session: 2, threadId: "t-2", createdAt: 2_000n, attached: true }),
	term({ session: 3, title: "old", createdAt: 3_000n, exited: true, exitCode: 129 }),
	term({ session: 4, threadId: "t-4", title: "claude", createdAt: 4_000n }),
];

/** A machine that lists `sessions` and forgets each one it is asked to close; `refuse` sessions it will not close. */
function fakeLink(sessions: readonly TermSessionInfo[], refuse: readonly number[] = []) {
	const sent: Frame["body"][] = [];
	let listed = [...sessions];
	return {
		sent,
		link: {
			request: (body: Body) => {
				const frame = create(FrameSchema, { body });
				sent.push(frame.body);
				if (frame.body.case === "termClose") {
					const closed = frame.body.value.session;
					if (refuse.includes(closed)) return Promise.reject(new RemoteError(ErrorCode.INVALID, "busy", ErrorReason.UNSPECIFIED));
					listed = listed.filter((s) => s.session !== closed);
					return Promise.resolve(create(FrameSchema, { body: { case: "termClosed", value: { session: closed } } }));
				}
				return Promise.resolve(create(FrameSchema, { body: { case: "termListResult", value: { sessions: listed, maxSessions: 20 } } }));
			},
		},
	};
}

const closes = (sent: readonly Frame["body"][]) => sent.flatMap((b) => (b.case === "termClose" ? [b.value.session] : []));

function show(sessions = SESSIONS, { refuse = [] as readonly number[], online = true, running = false } = {}) {
	const fake = fakeLink(sessions, refuse);
	const threads = [create(ThreadSummarySchema, { id: "t-2", title: "Sửa lỗi đăng nhập" }), create(ThreadSummarySchema, { id: "t-4", title: "claude", state: running ? ThreadState.RUNNING : ThreadState.IDLE })];
	render(
		<I18nProvider>
			<MachineTerminalSessions machine="pc" link={fake.link} online={online} threads={threads} />
		</I18nProvider>,
	);
	return fake;
}

/** The element with this data-id, once the machine's list is in. */
function byId<T extends HTMLElement = HTMLElement>(id: string): Promise<T> {
	return waitFor(() => {
		const el = document.querySelector<T>(`[data-id="${id}"]`);
		if (el === null) throw new Error(`${id} is not shown yet`);
		return el;
	});
}

describe("termState and sortTermSessions", () => {
	it("puts sessions open on a device first, then unwatched, then exited, newest first in each", () => {
		expect(SESSIONS.map(termState)).toEqual(["idle", "viewed", "exited", "idle"]);
		expect(sortTermSessions(SESSIONS).map((s) => s.session)).toEqual([2, 4, 1, 3]);
	});
});

describe("MachineTerminalSessions", () => {
	it("lists each session, an AI's under its thread's title, with a summary of the counts", async () => {
		show();
		const row = await byId("machine-terminal-2");
		expect(within(row).getByText("Sửa lỗi đăng nhập")).toBeTruthy();
		expect(document.querySelector('[data-id="machine-terminals-summary"]')?.textContent).toBe(viMachines.terminal.manage.summary(4, 1, 2));
		// An AI's session opens in its thread's terminal; a shell in the machine's terminal, by number; an exited one not at all.
		expect(document.querySelector('[data-id="machine-terminal-open-2"]')?.getAttribute("href")).toBe("/ai/pc/s/t-2/terminal");
		expect(document.querySelector('[data-id="machine-terminal-open-1"]')?.getAttribute("href")).toBe("/ai/pc/terminal?open=1");
		expect(document.querySelector('[data-id="machine-terminal-open-3"]')).toBeNull();
	});

	it("stops one session only after asking", async () => {
		const user = userEvent.setup();
		const { sent } = show();
		await user.click(await byId<HTMLButtonElement>("machine-terminal-stop-4"));
		expect(closes(sent)).toEqual([]);
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: viMachines.terminal.manage.stop }));
		await waitFor(() => expect(closes(sent)).toEqual([4]));
		await waitFor(() => expect(document.querySelector('[data-id="machine-terminal-4"]')).toBeNull());
	});

	it("stops every unwatched session at once and keeps the one open on a device", async () => {
		const user = userEvent.setup();
		const { sent } = show();
		await user.click(await byId<HTMLButtonElement>("machine-terminals-stop-idle"));
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: viMachines.terminal.manage.stopIdle(2) }));
		await waitFor(() => expect([...closes(sent)].sort()).toEqual([1, 4]));
		expect(document.querySelector('[data-id="machine-terminal-2"]')).not.toBeNull();
	});

	it("leaves an AI in the middle of a turn out of stopping all", async () => {
		const user = userEvent.setup();
		const { sent } = show(SESSIONS, { running: true });
		await user.click(await byId<HTMLButtonElement>("machine-terminals-stop-idle"));
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: viMachines.terminal.manage.stopIdle(1) }));
		await waitFor(() => expect(closes(sent)).toEqual([1]));
	});

	it("brings a session the machine refused to stop back, and says so", async () => {
		const user = userEvent.setup();
		show(SESSIONS, { refuse: [4] });
		await user.click(await byId<HTMLButtonElement>("machine-terminal-stop-4"));
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: viMachines.terminal.manage.stop }));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", viMachines.terminal.manage.failed);
		expect(document.querySelector('[data-id="machine-terminal-4"]')).not.toBeNull();
	});

	it("shows no list to act on while the machine is offline", () => {
		show(SESSIONS, { online: false });
		expect(document.querySelector(".mx-terms-list")).toBeNull();
		expect(screen.getByText(viMachines.detail.needsLink)).toBeTruthy();
	});

	it("drops an exited session from the list without asking", async () => {
		const user = userEvent.setup();
		const { sent } = show();
		await user.click(await byId<HTMLButtonElement>("machine-terminal-remove-3"));
		await waitFor(() => expect(closes(sent)).toEqual([3]));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("StopSessionButton", () => {
	it("asks in place: the first press arms it, the second stops", async () => {
		const user = userEvent.setup();
		let stopped = 0;
		render(<StopSessionButton t={viMachines.terminal} stop={{ label: "Dừng vim", exited: false, disabled: false, run: () => stopped++ }} className="tx-stop" />);
		const button = screen.getByRole("button", { name: "Dừng vim" });
		await user.click(button);
		expect(stopped).toBe(0);
		expect(button.hasAttribute("data-armed")).toBe(true);
		await user.click(button);
		expect(stopped).toBe(1);
	});

	it("drops an exited session with one press", async () => {
		const user = userEvent.setup();
		let stopped = 0;
		render(<StopSessionButton t={viMachines.terminal} stop={{ label: "Bỏ khỏi danh sách", exited: true, disabled: false, run: () => stopped++ }} className="tx-stop" />);
		await user.click(screen.getByRole("button", { name: "Bỏ khỏi danh sách" }));
		expect(stopped).toBe(1);
	});
});
