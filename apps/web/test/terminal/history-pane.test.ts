// The history above the live terminal: pages load as the view nears the top of what is loaded, go on top without
// moving the rows in view, stop at the first row, go when a program cleared the history, say when they could not
// be loaded and try again on a later scroll, stay under the line cap (pages far from the view go and come back),
// and a scroll moves from the live terminal across the rule into the history and back; a key returns to the
// newest line. xterm is replaced by a stand-in that keeps lines the way the pane reads them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryReply } from "../../src/terminal/terminal-history-requests.ts";

/** A terminal that keeps its text as lines (one per row; long lines take more), parsed in order after each write. */
class FakeXterm {
	static made: FakeXterm[] = [];
	cols: number;
	rows: number;
	options: Record<string, unknown>;
	unicode = { activeVersion: "6" };
	selected = "";
	disposed = false;
	private lines: string[] = [""];
	private viewport = 0;
	private queue: (() => void)[] = [];
	readonly buffer: { readonly active: { readonly type: string; readonly viewportY: number; readonly baseY: number; readonly cursorY: number } };

	constructor(options: Record<string, unknown> & { cols: number; rows: number }) {
		this.options = options;
		this.cols = options.cols;
		this.rows = options.rows;
		FakeXterm.made.push(this);
		const active = { type: "normal", viewportY: 0, baseY: 0, cursorY: 0 };
		Object.defineProperties(active, {
			viewportY: { get: () => this.viewport },
			baseY: { get: () => this.base() },
			cursorY: { get: () => this.total() - 1 - this.base() },
		});
		this.buffer = { active };
	}
	loadAddon(): void {}
	open(box: HTMLElement): void {
		box.appendChild(document.createElement("div")).className = "xterm";
	}
	write(data: Uint8Array, done?: () => void): void {
		const text = new TextDecoder().decode(data);
		this.queue.push(() => {
			this.parse(text);
			done?.();
		});
		if (this.queue.length === 1) queueMicrotask(() => this.drain());
	}
	resize(cols: number, rows: number): void {
		const atBottom = this.viewport >= this.base();
		this.cols = cols;
		this.rows = rows;
		this.viewport = atBottom ? this.base() : Math.min(this.viewport, this.base());
	}
	scrollLines(n: number): void {
		this.viewport = Math.max(0, Math.min(this.base(), this.viewport + n));
	}
	scrollToLine(n: number): void {
		this.viewport = Math.max(0, Math.min(this.base(), n));
	}
	scrollToBottom(): void {
		this.viewport = this.base();
	}
	scrollToTop(): void {
		this.viewport = 0;
	}
	getSelection(): string {
		return this.selected;
	}
	clearSelection(): void {
		this.selected = "";
	}
	dispose(): void {
		this.disposed = true;
	}
	/** The rows in view, as text. */
	lineAt(n: number): string {
		return this.visual()[n] ?? "";
	}
	inView(): string[] {
		return this.visual().slice(this.viewport, this.viewport + this.rows);
	}
	total(): number {
		return this.visual().length;
	}
	private base(): number {
		return Math.max(0, this.total() - this.rows);
	}
	private visual(): string[] {
		const out: string[] = [];
		for (const line of this.lines) for (let at = 0; at === 0 || at < line.length; at += this.cols) out.push(line.slice(at, at + this.cols));
		return out;
	}
	private drain(): void {
		while (this.queue.length > 0) this.queue.shift()?.();
	}
	private parse(text: string): void {
		const atBottom = this.viewport >= this.base();
		let rest = text;
		const reset = rest.lastIndexOf("\x1bc");
		if (reset >= 0) {
			this.lines = [""];
			this.viewport = 0;
			rest = rest.slice(reset + 2);
		}
		// eslint-disable-next-line no-control-regex
		for (const ch of rest.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) {
			if (ch === "\n") this.lines.push("");
			else if (ch !== "\r") this.lines[this.lines.length - 1] += ch;
		}
		if (atBottom || reset >= 0) this.viewport = this.base();
	}
}

vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: function Unicode11Addon() {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: function WebglAddon() {} }));
vi.mock("@xterm/xterm", () => ({ Terminal: FakeXterm }));

const { HistoryPane, MAX_HISTORY_LINES, RETRY_MS } = await import("../../src/terminal/history-pane.ts");
const { HistoryScroll } = await import("../../src/terminal/history-scroll.ts");

const ROW = 10;
const LABELS = { loading: "đang tải", start: "đầu lịch sử", cleared: "đã xoá", failed: "không tải được" };

/** The live terminal under the history. */
class FakeLive {
	rows = 24;
	element = document.createElement("div");
	modes = { mouseTrackingMode: "none" };
	viewportY = 0;
	baseY = 0;
	type = "normal";
	bottoms = 0;
	readonly buffer = { active: this };
	scrollLines(n: number): void {
		this.viewportY = Math.max(0, Math.min(this.baseY, this.viewportY + n));
	}
	scrollToBottom(): void {
		this.bottoms += 1;
		this.viewportY = this.baseY;
	}
}

/** The machine's history of `total` rows (row n reads `row n`, padded to `width`) in life `epoch`. */
function machine(total: number, epoch = 1, width = 0) {
	const asked: { before: number; max: number }[] = [];
	let answer: ((before: number, max: number) => HistoryReply | null) | null = null;
	const held: (() => void)[] = [];
	const rows = (before: number, max: number): HistoryReply => {
		const first = Math.max(0, before - max);
		const text = Array.from({ length: before - first }, (_, i) => `${`row ${first + i}`.padEnd(width, ".")}\x1b[m\r\n`).join("");
		return { kind: "rows", epoch, firstRow: first, rowCount: before - first, atStart: first === 0, vt: new TextEncoder().encode(text) };
	};
	return {
		asked,
		/** Answers with this instead (null: the rows); `hold` keeps answers until release(). */
		answerWith(fn: ((before: number, max: number) => HistoryReply | null) | null): void {
			answer = fn;
		},
		hold: false,
		release(): void {
			for (const run of held.splice(0)) run();
		},
		load(before: number, max: number): Promise<HistoryReply> {
			asked.push({ before, max });
			return new Promise((resolve) => {
				const run = () => resolve(answer?.(before, max) ?? rows(before, max));
				if (this.hold) held.push(run);
				else run();
			});
		},
	};
}

let host: HTMLDivElement;
let live: FakeLive;
let clock = 0;
let history: InstanceType<typeof HistoryPane>;
let scroll: InstanceType<typeof HistoryScroll>;
let source: ReturnType<typeof machine>;
/** The live terminal's width. */
let cols = 80;

function setup(total: number, epoch = 1, width = 0): void {
	source = machine(total, epoch, width);
	history = new HistoryPane({
		host,
		options: () => ({ fontSize: 14 }),
		cols: () => cols,
		rows: () => live.rows,
		load: (life, before, max) => {
			expect(life).toEqual({ epoch: lifeEpoch, historyEnd: lifeEnd });
			return source.load(before, max);
		},
		labels: () => LABELS,
		changed: () => scroll.layout(),
		now: () => clock,
	});
	scroll = new HistoryScroll({ live, pane: history, rowHeight: () => ROW });
	history.start(epoch, total);
	lifeEpoch = epoch;
	lifeEnd = total;
}
/** The life the pane was last started on: what it must ask for. */
let lifeEpoch = 0;
let lifeEnd = 0;

const settle = () => new Promise((r) => setTimeout(r, 0));
const term = (): FakeXterm => {
	const t = FakeXterm.made.at(-1);
	if (t === undefined) throw new Error("no history terminal yet");
	return t;
};
const status = () => (history.status.hidden ? "" : history.status.textContent);
/** Scrolls `rows` rows' worth (negative: older) and lets pages arrive. */
async function scrollRows(rows: number): Promise<void> {
	scroll.scroll(rows * ROW);
	await settle();
	await settle();
}

beforeEach(() => {
	FakeXterm.made = [];
	clock = 0;
	cols = 80;
	host = document.createElement("div");
	document.body.appendChild(host);
	live = new FakeLive();
	live.baseY = live.viewportY = 30;
});

afterEach(() => {
	host.remove();
});

describe("the history above the live terminal", () => {
	it("loads nothing until the user scrolls up, then a page that joins the live screen under the rule", async () => {
		setup(1_000);
		expect(source.asked).toEqual([]);
		expect(history.box.hidden).toBe(true);
		source.hold = true;
		// The live terminal's own history first: near its top the first page is already asked for.
		scroll.scroll(-20 * ROW);
		expect(live.viewportY).toBe(10);
		expect(source.asked).toEqual([{ before: 1_000, max: 500 }]);
		expect(history.box.hidden).toBe(true);
		// Past its top: the history shows, saying it loads.
		scroll.scroll(-15 * ROW);
		expect(live.viewportY).toBe(0);
		expect(history.box.hidden).toBe(false);
		expect(status()).toBe(LABELS.loading);
		source.hold = false;
		source.release();
		await settle();
		await settle();
		expect(status()).toBe("");
		expect(history.rowsShown()).toBe(24);
		// The newest row of the history sits right above the rule: the row before the live screen's first.
		expect(term().inView().at(-1)).toBe("row 999");
		expect(source.asked).toHaveLength(1);
	});

	it("keeps the rows in view when an older page goes on top", async () => {
		setup(2_000);
		live.viewportY = 0;
		await scrollRows(-30);
		// Into the history: 25 rows reveal it (24 rows and the rule), then its own lines scroll.
		await scrollRows(-25 - 400);
		const before = term().inView();
		expect(source.asked).toHaveLength(1);
		await scrollRows(-50);
		const shownBefore = term().inView();
		expect(shownBefore).not.toEqual(before);
		expect(source.asked).toHaveLength(2);
		expect(source.asked[1]).toEqual({ before: 1_500, max: 500 });
		// The page arrived above: the same rows are still in view.
		expect(term().inView()).toEqual(shownBefore);
		expect(term().total()).toBe(1_000);
	});

	it("stops at the first row and says so at the top", async () => {
		setup(600);
		live.viewportY = 0;
		await scrollRows(-25);
		await scrollRows(-1_000);
		await scrollRows(-1_000);
		expect(source.asked.map((a) => a.before)).toEqual([600, 100]);
		expect(term().inView()[0]).toBe("row 0");
		expect(status()).toBe(LABELS.start);
		await scrollRows(-100);
		expect(source.asked).toHaveLength(2);
		// Away from the top the label goes.
		await scrollRows(50);
		expect(status()).toBe("");
	});

	it("a session with no history before its screen says it is at the start, and asks nothing", async () => {
		setup(0);
		live.viewportY = 0;
		await scrollRows(-5);
		expect(source.asked).toEqual([]);
		expect(status()).toBe(LABELS.start);
	});

	it("drops what it loaded and stops when a program cleared the history (another life, ED 3, a new screen)", async () => {
		setup(1_000);
		live.viewportY = 0;
		source.answerWith(() => ({ kind: "rows", epoch: 2, firstRow: 0, rowCount: 0, atStart: true, vt: new Uint8Array() }));
		await scrollRows(-30);
		expect(status()).toBe(LABELS.cleared);
		await scrollRows(-30);
		expect(source.asked).toHaveLength(1);
		// Loaded, then cleared by the program: the rows go at once.
		setup(1_000);
		live.viewportY = 0;
		await scrollRows(-30);
		expect(history.rowsShown()).toBe(24);
		history.cleared();
		expect(history.rowsShown()).toBe(0);
		expect(status()).toBe(LABELS.cleared);
		// A new screen (LiveSnapshot) starts a new life: loading works again.
		history.start(1, 50);
		lifeEnd = 50;
		await scrollRows(-30);
		expect(term().inView().at(-1)).toBe("row 49");
	});

	it("says when a page could not be loaded, and asks again on a later scroll", async () => {
		setup(1_000);
		live.viewportY = 0;
		source.answerWith(() => ({ kind: "failed", reason: "timeout" }));
		await scrollRows(-30);
		expect(status()).toBe(LABELS.failed);
		await scrollRows(-5);
		expect(source.asked).toHaveLength(1);
		source.answerWith(null);
		clock += RETRY_MS;
		await scrollRows(-5);
		expect(source.asked).toHaveLength(2);
		expect(status()).toBe("");
		expect(history.rowsShown()).toBe(24);
	});

	it("drops an answer that no longer applies (the screen started over) and stays ready", async () => {
		setup(1_000);
		live.viewportY = 0;
		source.answerWith(() => ({ kind: "dropped" }));
		await scrollRows(-30);
		expect(status()).toBe("");
		expect(history.rowsShown()).toBe(0);
		// An answer for a life that ended meanwhile is not shown either.
		source.answerWith(null);
		source.hold = true;
		await scrollRows(-1);
		history.start(1, 400);
		lifeEnd = 400;
		source.hold = false;
		source.release();
		await settle();
		expect(history.rowsShown()).toBe(0);
	});

	it("holds at most the line cap: pages far from the view go, and come back on the way down to the live screen", async () => {
		setup(20_000);
		live.viewportY = 0;
		await scrollRows(-25);
		for (let i = 0; i < 40 && source.asked.length < 14; i++) await scrollRows(-500);
		expect(source.asked.length).toBeGreaterThanOrEqual(14);
		expect(term().total()).toBeLessThanOrEqual(MAX_HISTORY_LINES);
		expect(history.connected).toBe(false);
		const asked = source.asked.length;
		// Down again: the pages that went come back before the rule lets the live screen in.
		for (let i = 0; i < 80 && scroll.inHistory; i++) await scrollRows(500);
		expect(scroll.inHistory).toBe(false);
		expect(source.asked.length).toBeGreaterThan(asked);
		expect(term().total()).toBeLessThanOrEqual(MAX_HISTORY_LINES);
		expect(term().inView().at(-1)).toBe("row 19999");
	});

	it("a key goes back to the live terminal's newest line", async () => {
		setup(1_000);
		live.viewportY = 0;
		// The first scroll shows the history's status while its first page loads; the next one its rows.
		await scrollRows(-60);
		expect(live.element.style.transform).toBe(`translateY(${ROW + 1}px)`);
		await scrollRows(-60);
		expect(scroll.inHistory).toBe(true);
		expect(live.element.style.transform).toBe(`translateY(${24 * ROW + 1}px)`);
		scroll.toLive();
		expect(scroll.inHistory).toBe(false);
		expect(history.box.hidden).toBe(true);
		expect(live.element.style.transform).toBe("");
		expect(live.bottoms).toBe(1);
		expect(live.viewportY).toBe(30);
		// Its terminal went with the view (no WebGL context kept for it); the pages stayed.
		const first = term();
		expect(first.disposed).toBe(true);
		// Scrolled back up, the history is right there, from its newest row, without asking again.
		await scrollRows(-55);
		expect(term()).not.toBe(first);
		expect(term().inView().at(-1)).toBe("row 999");
		expect(source.asked).toHaveLength(1);
	});
});

describe("the history at another width", () => {
	it("narrower, stays under the line cap without losing rows: pages cut go and are asked for again", async () => {
		cols = 200;
		setup(20_000, 1, 190);
		live.viewportY = 0;
		await scrollRows(-25);
		for (let i = 0; i < 40 && source.asked.length < 10; i++) await scrollRows(-500);
		expect(term().total()).toBeLessThanOrEqual(MAX_HISTORY_LINES);
		expect(term().options.scrollback).toBeGreaterThanOrEqual(1_000_000);
		const topRow = () => Number(/^row (\d+)/.exec(term().lineAt(0))?.[1] ?? -1);
		// Each row now takes five lines: twice the cap, cut down by pages.
		cols = 40;
		history.refit();
		await settle();
		await settle();
		expect(term().cols).toBe(40);
		expect(term().total()).toBeLessThanOrEqual(MAX_HISTORY_LINES);
		const top = topRow();
		expect(top).toBeGreaterThan(0);
		// Up to the top of what is loaded: the next page asked for ends right where the loaded rows begin.
		const asked = source.asked.length;
		for (let i = 0; i < 200 && source.asked.length === asked; i++) await scrollRows(-500);
		expect(source.asked.at(-1)?.before).toBe(top);
		// Down to the live screen: the pages cut at the bottom come back first, joined row for row.
		for (let i = 0; i < 400 && scroll.inHistory; i++) await scrollRows(500);
		expect(scroll.inHistory).toBe(false);
		// The last row (five lines at this width) is the one right above the rule.
		expect(term().inView().slice(-5)[0]?.startsWith("row 19999")).toBe(true);
	});
});

describe("the wheel over the pane", () => {
	const wheel = (init: WheelEventInit) => new WheelEvent("wheel", { cancelable: true, ...init });

	it("stays xterm's while the live terminal has history above, and goes to the history past its top", async () => {
		setup(1_000);
		live.viewportY = 100;
		live.baseY = 100;
		const inLive = wheel({ deltaY: -30 });
		scroll.wheel(inLive);
		expect(inLive.defaultPrevented).toBe(false);
		expect(source.asked).toEqual([]);
		// Near its top, the first page is asked for ahead.
		live.viewportY = 20;
		scroll.wheel(wheel({ deltaY: -30 }));
		expect(source.asked).toHaveLength(1);
		live.viewportY = 0;
		const past = wheel({ deltaY: -30 });
		scroll.wheel(past);
		expect(past.defaultPrevented).toBe(true);
		expect(scroll.inHistory).toBe(true);
		// Lines, not pixels (Firefox): three rows.
		scroll.wheel(wheel({ deltaY: -3, deltaMode: 1 }));
		await settle();
		// Down from the history all the way: back to the live terminal, then xterm's again.
		const down = wheel({ deltaY: 10_000 });
		scroll.wheel(down);
		expect(down.defaultPrevented).toBe(true);
		expect(scroll.inHistory).toBe(false);
		const again = wheel({ deltaY: 30 });
		scroll.wheel(again);
		expect(again.defaultPrevented).toBe(false);
	});

	it("is the program's while it reads the mouse or shows a full screen; Shift + wheel opens the history", () => {
		setup(1_000);
		live.viewportY = 0;
		live.modes.mouseTrackingMode = "vt200";
		const program = wheel({ deltaY: -30 });
		scroll.wheel(program);
		expect(program.defaultPrevented).toBe(false);
		expect(scroll.inHistory).toBe(false);
		// Shift + wheel comes as a sideways scroll on some systems.
		const shifted = wheel({ deltaY: 0, deltaX: -30, shiftKey: true });
		scroll.wheel(shifted);
		expect(shifted.defaultPrevented).toBe(true);
		expect(scroll.inHistory).toBe(true);
		// In the history every wheel is the history's, Shift or not.
		const inHistory = wheel({ deltaY: 5 });
		scroll.wheel(inHistory);
		expect(inHistory.defaultPrevented).toBe(true);
		scroll.toLive();
		live.modes.mouseTrackingMode = "none";
		live.type = "alternate";
		const fullScreen = wheel({ deltaY: -30 });
		scroll.wheel(fullScreen);
		expect(fullScreen.defaultPrevented).toBe(false);
	});

	it("does nothing without a history to load (a replayed session, an older machine)", () => {
		setup(1_000);
		history.off();
		live.viewportY = 0;
		const event = wheel({ deltaY: -30 });
		scroll.wheel(event);
		expect(event.defaultPrevented).toBe(false);
		scroll.scroll(-300);
		expect(scroll.inHistory).toBe(false);
		expect(source.asked).toEqual([]);
	});
});
