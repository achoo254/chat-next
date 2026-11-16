// The pane on a machine that opens a session at its screen as it is now: no cover and no hidden replay, the pane
// shows and takes keys as soon as the screen is written, the wheel past the top asks for the history, a key
// brings the newest line back, and a program clearing its history drops it; on the older path (a preview while
// the whole stream replays) the cover still shows. xterm and its addons are stand-ins (jsdom has no canvas).
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryReply } from "../../src/terminal/terminal-history-requests.ts";
import type { TerminalLink, TerminalSink } from "../../src/terminal/terminal-link.ts";

type Listener = (value: never) => void;
/** ESC [ (?) params J, as xterm's parser hands it to a CSI handler. */
const ERASE_IN_DISPLAY = new RegExp(`${String.fromCharCode(27)}\\[(\\??)([0-9;]*)J`, "g");
type Csi = (params: (number | number[])[]) => boolean;

class FakeTerm {
	static made: FakeTerm[] = [];
	cols = 80;
	rows = 24;
	options: Record<string, unknown>;
	unicode = { activeVersion: "6" };
	element: HTMLElement | undefined;
	textarea: HTMLTextAreaElement | undefined;
	modes = { applicationCursorKeysMode: false, bracketedPasteMode: false, mouseTrackingMode: "none" };
	written = "";
	readonly buffer = {
		active: { type: "normal", viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, length: 0, getLine: () => undefined },
		onBufferChange: () => ({ dispose: () => undefined }),
	};
	readonly listeners = new Map<string, Listener[]>();
	private readonly csi = new Map<string, Csi>();
	private esc: (() => boolean) | null = null;
	readonly parser = {
		registerCsiHandler: (id: { prefix?: string; final: string }, handler: Csi) => {
			this.csi.set(`${id.prefix ?? ""}${id.final}`, handler);
			return { dispose: () => undefined };
		},
		registerEscHandler: (id: { final: string }, handler: () => boolean) => {
			if (id.final === "c") this.esc = handler;
			return { dispose: () => undefined };
		},
	};

	constructor(options: Record<string, unknown>) {
		this.options = { ...options };
		FakeTerm.made.push(this);
	}
	private on(name: string) {
		return (fn: Listener) => {
			this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
			return { dispose: () => undefined };
		};
	}
	onData = this.on("data");
	onBinary = this.on("binary");
	onResize = this.on("resize");
	onTitleChange = this.on("title");
	onWriteParsed = this.on("parsed");
	onScroll = this.on("scroll");
	/** What xterm would hand to onData for a key. */
	type(data: string): void {
		for (const fn of this.listeners.get("data") ?? []) (fn as (d: string) => void)(data);
	}
	loadAddon(): void {}
	open(host: HTMLElement): void {
		const element = host.appendChild(document.createElement("div"));
		element.className = "xterm";
		this.element = element;
		this.textarea = element.appendChild(document.createElement("textarea"));
	}
	write(data: Uint8Array | string, done?: () => void): void {
		const text = typeof data === "string" ? data : new TextDecoder().decode(data);
		// What xterm's parser would call: the clears the pane watches.
		for (const m of text.matchAll(ERASE_IN_DISPLAY)) this.csi.get(`${m[1]}J`)?.((m[2] ?? "").split(";").map((n) => Number(n || 0)));
		if (text.includes("\x1bc")) this.esc?.();
		this.written += text;
		queueMicrotask(() => done?.());
	}
	attachCustomKeyEventHandler(): void {}
	reset(): void {
		this.written = "";
	}
	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
	}
	scrollLines(): void {}
	scrollToLine(): void {}
	scrollToTop(): void {}
	scrollToBottom(): void {}
	focus(): void {}
	refresh(): void {}
	selected = "";
	getSelection(): string {
		return this.selected;
	}
	hasSelection(): boolean {
		return this.selected !== "";
	}
	clearSelection(): void {}
	dispose(): void {}
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerm }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: function Unicode11Addon() {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: function WebLinksAddon() {} }));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		onContextLoss(): void {}
		clearTextureAtlas(): void {}
		dispose(): void {}
	},
}));

const { TerminalView } = await import("../../src/terminal/terminal-view.tsx");
const { I18nProvider } = await import("../../src/i18n/i18n.tsx");
const { viMachines } = await import("../../src/machines/copy-vi.ts");

/** The link as the pane sees it: what it attached, typed, sized and asked of the history. */
class FakeLink {
	sink: TerminalSink | null = null;
	readonly inputs: string[] = [];
	readonly asked: { before: number; max: number }[] = [];
	attach(_session: number, sink: TerminalSink): () => void {
		this.sink = sink;
		return () => (this.sink = null);
	}
	input(_session: number, data: Uint8Array): void {
		this.inputs.push(new TextDecoder().decode(data));
	}
	resize(): void {}
	/** The answer to every page asked for; null: none comes. */
	reply: HistoryReply | null = null;
	history(_session: number, _life: unknown, before: number, max: number): Promise<HistoryReply> {
		this.asked.push({ before, max });
		const reply = this.reply;
		return reply === null ? new Promise(() => undefined) : Promise.resolve(reply);
	}
}

const NativeResizeObserver = globalThis.ResizeObserver;
let link: FakeLink;
let pane: HTMLElement;
/** What the pane registered with the dock. */
let handle: { selection(): string } | null = null;

beforeEach(() => {
	FakeTerm.made = [];
	globalThis.ResizeObserver = class {
		observe(): void {}
		disconnect(): void {}
		unobserve(): void {}
	} as unknown as typeof ResizeObserver;
	link = new FakeLink();
});

afterEach(() => {
	globalThis.ResizeObserver = NativeResizeObserver;
});

const live = (): FakeTerm => {
	const t = FakeTerm.made[0];
	if (t === undefined) throw new Error("no terminal");
	return t;
};
const noop = () => undefined;

async function show(): Promise<TerminalSink> {
	const view = render(
		<I18nProvider>
			<TerminalView
				link={link as unknown as TerminalLink}
				session={7}
				focused
				touch={false}
				label="Terminal"
				openingLabel="Đang mở…"
				syncingLabel="Đang đồng bộ"
				probe={null}
				onFocus={noop}
				onTitle={noop}
				onExit={noop}
				onGone={noop}
				onShortcut={() => false}
				register={(h) => (handle = h)}
			/>
		</I18nProvider>,
	);
	await waitFor(() => expect(link.sink).not.toBeNull());
	const box = view.container.querySelector<HTMLElement>(".tx-term");
	if (box === null) throw new Error("no pane");
	pane = box;
	// The pane's rows are 10 px tall.
	Object.defineProperty(pane, "clientHeight", { configurable: true, value: 240 });
	return link.sink as TerminalSink;
}

const wheelUp = () => {
	const event = new WheelEvent("wheel", { deltaY: -300, cancelable: true, bubbles: true });
	act(() => {
		pane.dispatchEvent(event);
	});
	return event;
};

describe("a session opened at its screen as it is now", () => {
	it("shows it without a cover or a replay and takes keys once it is written", async () => {
		const sink = await show();
		expect(document.body.textContent).toContain("Đang mở…");
		act(() => sink.liveSnapshot?.({ cols: 80, rows: 24, vt: new TextEncoder().encode("\x1bc$ "), epoch: 1, historyEnd: 500 }));
		await waitFor(() => expect(document.body.textContent).not.toContain("Đang mở…"));
		expect(pane.querySelector(".tx-preview")).toBeNull();
		expect(live().element?.style.opacity).toBe("");
		expect(live().written).toBe("\x1bc$ ");
		live().type("l");
		expect(link.inputs).toEqual(["l"]);
	});

	it("asks for the history past the top, goes back to the newest line on a key, and drops it when the program clears it", async () => {
		const sink = await show();
		act(() => sink.liveSnapshot?.({ cols: 80, rows: 24, vt: new TextEncoder().encode("$ "), epoch: 1, historyEnd: 500 }));
		await waitFor(() => expect(document.body.textContent).not.toContain("Đang mở…"));
		const history = pane.querySelector<HTMLElement>(".tx-history");
		expect(history?.hidden).toBe(true);
		expect(wheelUp().defaultPrevented).toBe(true);
		expect(link.asked).toEqual([{ before: 500, max: 500 }]);
		expect(history?.hidden).toBe(false);
		expect(pane.querySelector(".tx-history-status")?.textContent).toBe(viMachines.terminal.history.loading);
		// A key: back to the live terminal.
		act(() => live().type("x"));
		expect(history?.hidden).toBe(true);
		expect(live().element?.style.transform).toBe("");
		// The program clears its history (ED 3): what came before is gone, and is not asked for again.
		act(() => sink.output(new TextEncoder().encode("\x1b[3J"), noop));
		await act(() => Promise.resolve());
		wheelUp();
		expect(pane.querySelector(".tx-history-status")?.textContent).toBe(viMachines.terminal.history.cleared);
		expect(link.asked).toHaveLength(1);
	});

	it("stays in the history when xterm reports focus, the mouse or an answer to the program; a typed key leaves it", async () => {
		const sink = await show();
		act(() => sink.liveSnapshot?.({ cols: 80, rows: 24, vt: new TextEncoder().encode("$ "), epoch: 1, historyEnd: 500 }));
		await waitFor(() => expect(document.body.textContent).not.toContain("Đang mở…"));
		wheelUp();
		const history = pane.querySelector<HTMLElement>(".tx-history");
		expect(history?.hidden).toBe(false);
		// A click into the history blurs the terminal (DECSET 1004 on: ESC[O), focus comes back, the program asks.
		for (const report of ["\x1b[O", "\x1b[I", "\x1b[<0;3;4M", "\x1b[12;1R"]) act(() => live().type(report));
		expect(history?.hidden).toBe(false);
		// They still reach the program.
		expect(link.inputs).toEqual(["\x1b[O", "\x1b[I", "\x1b[<0;3;4M", "\x1b[12;1R"]);
		act(() => live().type("q"));
		expect(history?.hidden).toBe(true);
	});

	it("gives the dock's copy key the text selected in the history", async () => {
		link.reply = { kind: "rows", epoch: 1, firstRow: 0, rowCount: 2, atStart: true, vt: new TextEncoder().encode("one\x1b[m\r\ntwo\x1b[m\r\n") };
		const sink = await show();
		act(() => sink.liveSnapshot?.({ cols: 80, rows: 24, vt: new TextEncoder().encode("$ "), epoch: 1, historyEnd: 2 }));
		await waitFor(() => expect(document.body.textContent).not.toContain("Đang mở…"));
		wheelUp();
		await waitFor(() => expect(FakeTerm.made.length).toBeGreaterThan(1));
		expect(handle?.selection()).toBe("");
		const pageTerm = FakeTerm.made.at(-1);
		if (pageTerm !== undefined) pageTerm.selected = "two";
		expect(handle?.selection()).toBe("two");
		// A selection in the live terminal comes first.
		live().selected = "$ ";
		expect(handle?.selection()).toBe("$ ");
	});

	it("still covers the pane with the machine's preview while a session on a full-screen program replays", async () => {
		const sink = await show();
		act(() => sink.preview?.({ cols: 80, rows: 24, altScreen: true, vt: new TextEncoder().encode("vim") }));
		expect(pane.querySelector(".tx-preview")).not.toBeNull();
		expect(live().element?.style.opacity).toBe("0");
		// Its history is all in the replay: the wheel stays the terminal's.
		act(() => sink.snapshot({ cols: 80, rows: 24, altScreen: false, vt: new TextEncoder().encode("\x1bc") }));
		expect(wheelUp().defaultPrevented).toBe(false);
		expect(link.asked).toEqual([]);
	});
});
