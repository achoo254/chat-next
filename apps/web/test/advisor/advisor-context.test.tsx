// Where a copy was made, for Advisor: Source Control's copy carries the
// failed push's failure_id with the session's machine, thread and folder; a
// plain chat says only "chat"; a bot token (a screen with secrets, or text
// that looks like one) is never kept; xterm's selection comes from the
// terminal itself; the chip offers the newest copy for 10 minutes, once.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair } from "@achoo254/chat-remote-protocol";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForCopies, rememberCopy, setRouteContext, useAdvisorScope, type ScopeContext } from "../../src/advisor/advisor-context.tsx";
import { routeContextOf } from "../../src/advisor/advisor-mascot.tsx";
import { advisorStore, AdvisorStore, EMPTY_CONTEXT, OFFER_WINDOW_MS } from "../../src/advisor/advisor-store.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { DEFAULT_PREFS, type PanelPrefs } from "../../src/machines/workspace/panel-prefs.ts";
import WorkspacePanel from "../../src/machines/workspace/workspace-panel.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { CopyButton, copyText } from "../../src/messaging/ui/parts.tsx";
import { OneTimeUrlDialog as HookUrlDialog } from "../../src/messaging/integrations/hook-parts.tsx";
import { rememberCopies } from "../../src/terminal/terminal-view.tsx";
import { FakeWorkspace } from "../support/fake-workspace.ts";
import { defaultAnswer, FakeMachine, until } from "../machines/fake-machine.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const timers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	setInterval: () => 0,
	clearInterval: () => undefined,
	now: () => Date.now(),
};
const services = { toasts: { show: () => undefined } } as unknown as Services;

let stop: () => void = () => undefined;

beforeEach(() => {
	advisorStore.forgetAll();
	setRouteContext({});
	stop = listenForCopies(document, advisorStore);
});

afterEach(() => {
	stop();
	document.getSelection()?.removeAllRanges();
});

/** Selects the text of `element` and fires the copy event the browser would. */
function copyFrom(element: Element): void {
	const range = document.createRange();
	range.selectNodeContents(element);
	const selection = document.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	element.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
}

/** A screen declaring its context on its root, as session-chat.tsx does. */
function Scope({ context, children }: { context: ScopeContext; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useAdvisorScope(ref, context);
	return <div ref={ref}>{children}</div>;
}

const copies = () => advisorStore.snapshot().copies;

describe("Source Control", () => {
	let machine: FakeMachine;
	let ws: FakeWorkspace;
	let link: MachineLink;

	beforeEach(async () => {
		machine = await FakeMachine.create();
		const device = await generateKeyPair();
		machine.trusted = [device.publicKey];
		ws = new FakeWorkspace();
		machine.handler = (frame) => ws.handle(frame) ?? defaultAnswer(frame);
		link = new MachineLink({
			device: () => Promise.resolve(device),
			expectedKey: () => machine.keys.publicKey,
			tunnelUrl: () => URL_A,
			refreshTunnel: () => Promise.resolve(URL_A),
			socket: machine.factory,
			timers,
			random: () => 0,
		});
		link.start();
		await until(() => link.snapshot().status.kind === "open", "open");
	});

	afterEach(() => link.stop());

	function Panel() {
		const [prefs, setPrefs] = useState<PanelPrefs>({ ...DEFAULT_PREFS, open: true, tab: "scm" });
		return (
			<WorkspacePanel
				link={link}
				workspace={{ id: "pr1", name: "demo-app", dir: "/code/demo-app" }}
				online
				ai="Claude Code"
				writer={undefined}
				prefs={prefs}
				onPrefs={(change) => setPrefs((x) => ({ ...x, ...change }))}
				onTerminal={undefined}
			/>
		);
	}

	it("a copy of a failed push carries its failure_id, the action, the branch and the session's place", async () => {
		ws.failures.set("wsGitPush", { reason: ErrorReason.GIT_DIVERGED, subject: "1 1", failureId: "fail-42" });
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<Scope context={{ screen: "session", machine: "m1", threadId: "t-7", dir: "/code/demo-app", branch: "main" }}>
						<Panel />
					</Scope>
				</ServicesContext>
			</I18nProvider>,
		);
		await userEvent.click(await screen.findByRole("button", { name: /^Push/ }, { timeout: 4000 }));
		const alert = await screen.findByRole("alert");
		const reason = alert.querySelector("p");
		if (reason === null) throw new Error("no failure text");
		copyFrom(reason);
		expect(copies()).toHaveLength(1);
		expect(copies()[0]?.text).toBe(reason.textContent?.trim());
		expect(copies()[0]?.context).toEqual({
			...EMPTY_CONTEXT,
			screen: "scm",
			machine: "m1",
			threadId: "t-7",
			dir: "/code/demo-app",
			// Source Control's own branch wins over the session's.
			branch: "feat/workspace-panel",
			panel: "scm",
			action: "push",
			errorCode: "GIT_DIVERGED",
			failureId: "fail-42",
		});
		// Dismissed, the failure still names what the user copied a moment ago.
		await userEvent.click(within(alert).getByRole("button", { name: /Đóng/ }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		const title = screen.getByRole("region", { name: /Quản lý mã nguồn|Source Control/ }).querySelector("h2") ?? document.body;
		copyFrom(title);
		expect(copies()[0]?.context.failureId).toBe("fail-42");
		// The next push succeeds: copies no longer name the old failure.
		await userEvent.click(screen.getByRole("button", { name: /^Push/ }));
		await waitFor(() => expect(ws.seen.filter((b) => b.case === "wsGitPush")).toHaveLength(2));
		await waitFor(() => expect((screen.getByRole("button", { name: /^Push/ }) as HTMLButtonElement).disabled).toBe(false));
		copyFrom(title);
		expect(copies()[0]?.context).toMatchObject({ panel: "scm", action: "", errorCode: "", failureId: "" });
	});
});

describe("other screens", () => {
	it("a plain chat says only that it was a chat message: no id, no name", () => {
		setRouteContext(routeContextOf({ name: "chat", chatId: 5001, topicId: 0, panel: null } as never));
		render(<p>Hẹn 9 giờ sáng mai ở phòng họp tầng 3</p>);
		copyFrom(screen.getByText(/Hẹn 9 giờ/));
		expect(copies()[0]?.context).toEqual({ ...EMPTY_CONTEXT, screen: "chat" });
	});

	it("never keeps a copy from a screen with secrets, nor text that looks like a secret", async () => {
		render(
			<>
				<div data-advisor-ignore="">
					<code>123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw</code>
				</div>
				<p>token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8</p>
				<input aria-label="password" type="password" defaultValue="hunter2-hunter2" />
			</>,
		);
		copyFrom(screen.getByText(/123456:/));
		copyFrom(screen.getByText(/ghp_/));
		const password = screen.getByLabelText("password") as HTMLInputElement;
		password.setSelectionRange(0, password.value.length);
		password.dispatchEvent(new Event("copy", { bubbles: true }));
		expect(copies()).toHaveLength(0);

		// The copy buttons write the clipboard themselves: one in a screen with secrets is never kept.
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		stop();
		stop = listenForCopies(document, advisorStore);
		render(
			<>
				<div data-advisor-ignore="">
					<button type="button" onClick={() => void copyText("123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")}>
						Sao chép token
					</button>
				</div>
				<button type="button" onClick={() => void copyText("pnpm --filter ./apps/web test")}>
					Sao chép lệnh
				</button>
			</>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Sao chép token" }));
		await userEvent.click(screen.getByRole("button", { name: "Sao chép lệnh" }));
		expect(writeText).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(copies().map((c) => c.text)).toEqual(["pnpm --filter ./apps/web test"]));
		// A second watcher on top, the first one stopped: writes still pass, kept once (by the one still listening).
		const other = new AdvisorStore();
		const stopOther = listenForCopies(document, other);
		stop();
		await copyText("git status");
		expect(writeText).toHaveBeenCalledTimes(3);
		expect(copies().map((c) => c.text)).not.toContain("git status");
		expect(other.snapshot().copies.map((c) => c.text)).toEqual(["git status"]);
		stopOther();
		stop = listenForCopies(document, advisorStore);
		// Advisor stops listening: the clipboard is the browser's own again.
		stop();
		expect((navigator.clipboard as unknown as { writeText: unknown }).writeText).toBe(writeText);
		stop = listenForCopies(document, advisorStore);
	});

	it("drops a selection that runs into a screen with secrets, wherever it starts", () => {
		render(
			<div>
				<p>Lưu token này ngay, nó chỉ hiện một lần.</p>
				<div data-advisor-ignore="">
					<code>123456:shortish</code>
				</div>
			</div>,
		);
		const warning = screen.getByText(/Lưu token/);
		const token = screen.getByText(/123456/);
		const range = document.createRange();
		range.setStart(warning.firstChild ?? warning, 0);
		range.setEnd(token.firstChild ?? token, 6);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		warning.dispatchEvent(new Event("copy", { bubbles: true }));
		expect(copies()).toHaveLength(0);
	});

	it("the one-time webhook URL and its command are never offered: their dialog is a screen with secrets", async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		stop();
		stop = listenForCopies(document, advisorStore);
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<HookUrlDialog title="Đã tạo webhook" url="https://chat.example/hook/demo/opensesame" format="native" hookName="CI" chatTitle="Nhóm" onDone={() => undefined} />
					<CopyButton text="pnpm test" label="Sao chép lệnh" copiedLabel="Đã chép" />
				</ServicesContext>
			</I18nProvider>,
		);
		const dialog = await screen.findByRole("dialog");
		for (const button of within(dialog).getAllByRole("button", { name: /Sao chép|Copy/ })) await userEvent.click(button);
		await userEvent.click(screen.getByRole("button", { name: "Sao chép lệnh" }));
		await waitFor(() => expect(copies().map((c) => c.text)).toEqual(["pnpm test"]));
		expect(writeText.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("reads a field's own selection", () => {
		render(<textarea aria-label="note" defaultValue="git push origin main failed" />);
		const field = screen.getByLabelText("note") as HTMLTextAreaElement;
		field.setSelectionRange(0, 8);
		field.dispatchEvent(new Event("copy", { bubbles: true }));
		expect(copies()[0]?.text).toBe("git push");
	});

	it("takes xterm's selection from the terminal, not the page, and only once", () => {
		render(
			<Scope context={{ screen: "terminal", machine: "m1" }}>
				<div data-testid="host">
					<div className="xterm">
						<textarea aria-label="terminal input" />
					</div>
				</div>
			</Scope>,
		);
		const off = rememberCopies(screen.getByTestId("host"), () => "npm ERR! code E404");
		act(() => {
			screen.getByLabelText("terminal input").dispatchEvent(new Event("copy", { bubbles: true }));
		});
		off.dispose();
		expect(copies()).toHaveLength(1);
		expect(copies()[0]).toMatchObject({ text: "npm ERR! code E404", context: { ...EMPTY_CONTEXT, screen: "terminal", machine: "m1" } });
	});
});

describe("the copies kept", () => {
	it("offers the newest copy for 10 minutes, never one attached or dismissed, and keeps five", () => {
		let now = 1_000_000;
		const store = new AdvisorStore(() => now);
		for (const n of [1, 2, 3, 4, 5, 6]) store.remember(`copy ${n}`, EMPTY_CONTEXT);
		expect(store.snapshot().copies.map((c) => c.text)).toEqual(["copy 6", "copy 5", "copy 4", "copy 3", "copy 2"]);
		// The same text again moves up instead of filling the list.
		store.remember("copy 3", EMPTY_CONTEXT);
		expect(store.snapshot().copies.map((c) => c.text)).toEqual(["copy 3", "copy 6", "copy 5", "copy 4", "copy 2"]);
		const offered = store.offer();
		expect(offered?.text).toBe("copy 3");
		store.markUsed([offered?.id ?? ""]);
		expect(store.offer()).toBeNull();
		store.remember("copy 7", EMPTY_CONTEXT);
		now += OFFER_WINDOW_MS + 1;
		expect(store.offer()).toBeNull();
		expect(rememberCopy("   ", null, store)).toBe(false);
	});

	it("nothing of the account's Advisor outlives a sign-out; a remount keeps it", async () => {
		window.sessionStorage.clear();
		const store = new AdvisorStore();
		store.remember("copied", EMPTY_CONTEXT);
		store.addQuestion({ id: "q1", machine: "m1", threadId: "a1", dir: "", askedAt: 1, text: "?", attached: [], sent: true, error: "" });
		store.fill("m1", "s1", "pick");
		store.setSession({ machine: "m1", threadId: "s1" });
		// React remounting the mascot (StrictMode) asks to forget and keeps at once.
		store.forgetSoon();
		store.keep();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(store.snapshot().questions).toHaveLength(1);
		store.forgetSoon();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(store.snapshot()).toMatchObject({ copies: [], questions: [], session: null });
		expect(store.snapshot().fills.size).toBe(0);
		expect(window.sessionStorage.getItem("advisor:questions")).toBeNull();
		expect(new AdvisorStore().snapshot().questions).toHaveLength(0);
	});

	it("never stores a copy: only the questions' ids stay in this tab", () => {
		window.sessionStorage.clear();
		const store = new AdvisorStore();
		store.remember("secret plans", EMPTY_CONTEXT);
		store.addQuestion({ id: "q1", machine: "m1", threadId: "a1", dir: "/w", askedAt: 1, text: "Vì sao push hỏng?", tone: "short", attached: [], sent: true, error: "" });
		const stored = JSON.stringify({ ...window.sessionStorage }) + JSON.stringify({ ...window.localStorage });
		expect(stored).not.toContain("secret plans");
		expect(stored).not.toContain("push hỏng");
		expect(new AdvisorStore().snapshot().questions.map((q) => [q.id, q.threadId, q.text])).toEqual([["q1", "a1", ""]]);
	});
});
