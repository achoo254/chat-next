// A long session opened fresh: the machine's rendering covers the pane at
// once while the real terminal takes the replay out of sight; the real one
// shows once the replay caught up and the output went quiet, after a bounded
// wait when it never does, and the cover never stays for good.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const written: string[] = [];
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		open(box: HTMLElement): void {
			box.appendChild(document.createElement("div")).className = "xterm";
		}
		write(data: Uint8Array, done?: () => void): void {
			written.push(new TextDecoder().decode(data));
			done?.();
		}
		scrollToBottom(): void {}
		dispose(): void {}
	},
}));

const { COVER_MAX_MS, PreviewCover, QUIET_MS, SETTLE_MAX_MS } = await import("../../src/terminal/terminal-preview.ts");

let host: HTMLDivElement;
let real: HTMLDivElement;
let shownReal = 0;

function cover() {
	return new PreviewCover({ host, real: () => real, showReal: () => (shownReal += 1), options: () => ({}), now: () => Date.now() });
}

const preview = { cols: 80, rows: 24, altScreen: false, vt: new TextEncoder().encode("\x1bcthe newest line") };
const covering = () => host.querySelector(".tx-preview") !== null;

beforeEach(() => {
	vi.useFakeTimers();
	written.length = 0;
	shownReal = 0;
	host = document.createElement("div");
	real = host.appendChild(document.createElement("div"));
	document.body.appendChild(host);
});

afterEach(() => {
	vi.useRealTimers();
	host.remove();
});

describe("the preview of a session opened fresh", () => {
	it("covers the pane at once with the machine's rendering and keeps the real terminal out of sight", () => {
		const c = cover();
		c.show(preview);
		expect(covering()).toBe(true);
		expect(written).toEqual(["\x1bcthe newest line"]);
		expect(real.style.visibility).toBe("hidden");
		// The replay goes on: nothing shows until it caught up.
		for (let i = 0; i < 20; i++) {
			c.output();
			vi.advanceTimersByTime(100);
		}
		expect(covering()).toBe(true);
		c.dispose();
	});

	it("shows the real terminal at its newest line once the replay caught up and the output went quiet", () => {
		const c = cover();
		c.show(preview);
		c.output();
		c.caughtUp();
		// The program redraws for this screen right after attaching: still covered while it does.
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(50);
			c.output();
		}
		expect(covering()).toBe(true);
		vi.advanceTimersByTime(QUIET_MS + 60);
		expect(covering()).toBe(false);
		expect(real.style.visibility).toBe("");
		expect(shownReal).toBe(1);
	});

	it("shows the real terminal after a bounded wait when a running turn keeps printing", () => {
		const c = cover();
		c.show(preview);
		c.caughtUp();
		const timer = setInterval(() => c.output(), 20);
		vi.advanceTimersByTime(SETTLE_MAX_MS - 100);
		expect(covering()).toBe(true);
		vi.advanceTimersByTime(200);
		expect(covering()).toBe(false);
		clearInterval(timer);
	});

	it("never stays for good, and leaves nothing behind when the pane goes", () => {
		const c = cover();
		c.show(preview);
		vi.advanceTimersByTime(COVER_MAX_MS + 100);
		expect(covering()).toBe(false);
		expect(shownReal).toBe(1);
		c.show(preview);
		c.dispose();
		expect(covering()).toBe(false);
		expect(real.style.visibility).toBe("");
	});
});
