import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { formatLines, showTouchThumb, thumbGeometry } from "../../src/terminal/terminal-touch-thumb.ts";

describe("the thumb of a touch screen's history", () => {
	it("has none without history, or without room", () => {
		expect(thumbGeometry(24, 0, 0, 600).visible).toBe(false);
		expect(thumbGeometry(24, 100, 0, 0).visible).toBe(false);
		expect(thumbGeometry(0, 100, 0, 600).visible).toBe(false);
	});

	it("is the share of the history one screen is, never shorter than a thumb a finger can see", () => {
		// 24 rows over 24 lines of history: half the track.
		expect(thumbGeometry(24, 24, 0, 600).height).toBe(300);
		// A long history: kept at the minimum.
		expect(thumbGeometry(24, 50_000, 0, 600).height).toBe(36);
		// Never taller than the track.
		expect(thumbGeometry(24, 1, 0, 20).height).toBe(20);
	});

	it("rides from the top (the oldest line) to the bottom (the newest)", () => {
		const top = thumbGeometry(24, 100, 0, 600);
		const middle = thumbGeometry(24, 100, 50, 600);
		const bottom = thumbGeometry(24, 100, 100, 600);
		expect(top.top).toBe(0);
		expect(middle.top).toBeCloseTo((600 - middle.height) / 2);
		expect(bottom.top).toBeCloseTo(600 - bottom.height);
		// A position outside the history stays on the track.
		expect(thumbGeometry(24, 100, -5, 600).top).toBe(0);
		expect(thumbGeometry(24, 100, 500, 600).top).toBeCloseTo(600 - bottom.height);
	});
});

describe("the lines the button shows", () => {
	it("says whole lines up to 999, then thousands with one decimal", () => {
		expect([0, 1, 42, 999].map(formatLines)).toEqual(["0", "1", "42", "999"]);
		expect([1000, 1240, 1250, 9999, 12_400, 100_000].map(formatLines)).toEqual(["1k", "1.2k", "1.3k", "10k", "12.4k", "100k"]);
		expect(formatLines(-3)).toBe("0");
	});
});

/** The parts of xterm the thumb reads, with the events it listens to. */
function stubTerminal(rows: number) {
	const listeners = new Set<() => void>();
	const on = (fn: () => void) => {
		listeners.add(fn);
		return { dispose: () => listeners.delete(fn) };
	};
	const buffer = { type: "normal" as "normal" | "alternate", baseY: 0, viewportY: 0 };
	const term = {
		rows,
		buffer: { active: buffer, onBufferChange: on },
		onScroll: on,
		onWriteParsed: on,
		onResize: on,
		scrollToBottom: vi.fn(() => {
			buffer.viewportY = buffer.baseY;
			for (const fn of listeners) fn();
		}),
	};
	const fire = () => {
		for (const fn of listeners) fn();
	};
	return { term: term as unknown as Terminal, raw: term, buffer, fire, listeners };
}

describe("the thumb and the way back on a touch screen", () => {
	function mount() {
		const host = document.createElement("div");
		Object.defineProperty(host, "clientHeight", { value: 600 });
		document.body.append(host);
		const stub = stubTerminal(24);
		const handle = showTouchThumb(host, stub.term, "Back to the newest line");
		const thumb = () => host.querySelector<HTMLElement>(".tx-thumb");
		const latest = () => host.querySelector<HTMLButtonElement>(".tx-latest");
		return { host, handle, thumb, latest, ...stub };
	}

	it("shows nothing without history, then a thumb that is bright only while it moves, and the button once away from the newest line", () => {
		const m = mount();
		expect(m.thumb()?.hasAttribute("data-on")).toBe(false);
		expect(m.latest()?.hidden).toBe(true);

		// History grows while the view follows the bottom: the thumb is there, faint, and output does not light it up.
		m.buffer.baseY = 200;
		m.buffer.viewportY = 200;
		m.fire();
		expect(m.thumb()?.hasAttribute("data-on")).toBe(true);
		expect(m.thumb()?.hasAttribute("data-active")).toBe(false);
		expect(m.latest()?.hidden).toBe(true);

		// A finger scrolls up: the thumb lights up and the button offers the way back.
		m.buffer.viewportY = 120;
		m.fire();
		expect(m.thumb()?.hasAttribute("data-active")).toBe(true);
		expect(m.latest()?.hidden).toBe(false);
		expect(m.latest()?.getAttribute("aria-label")).toBe("Back to the newest line (80)");
		expect(m.latest()?.textContent).toBe("80");
		// Further up: the count follows.
		m.buffer.viewportY = 0;
		m.fire();
		expect(m.latest()?.textContent).toBe("200");

		// The button goes to the newest output, and is gone once there.
		m.latest()?.click();
		expect(m.raw.scrollToBottom).toHaveBeenCalledOnce();
		expect(m.latest()?.hidden).toBe(true);
		m.handle.dispose();
	});

	it("has no thumb on a full-screen program's screen, which keeps no history; and leaves nothing behind when disposed", () => {
		const m = mount();
		m.buffer.baseY = 200;
		m.buffer.viewportY = 50;
		m.fire();
		expect(m.thumb()?.hasAttribute("data-on")).toBe(true);
		m.buffer.type = "alternate";
		m.fire();
		expect(m.thumb()?.hasAttribute("data-on")).toBe(false);
		expect(m.latest()?.hidden).toBe(true);
		m.handle.dispose();
		expect(m.host.querySelector(".tx-thumb")).toBeNull();
		expect(m.host.querySelector(".tx-latest")).toBeNull();
		expect(m.listeners.size).toBe(0);
	});

	it("keeps a tap on the button from reaching the pane under it (no scroll, no keyboard)", () => {
		const m = mount();
		m.buffer.baseY = 200;
		m.buffer.viewportY = 10;
		m.fire();
		const reached = vi.fn();
		m.host.addEventListener("pointerup", reached);
		m.latest()?.dispatchEvent(new Event("pointerup", { bubbles: true }));
		expect(reached).not.toHaveBeenCalled();
		m.handle.dispose();
	});
});
