import { describe, expect, it } from "vitest";
import { TAP_SLOP_PX, TouchScroller } from "../../src/terminal/touch-scroll.ts";

function scroller() {
	const scrolled: number[] = [];
	const frames: ((now: number) => void)[] = [];
	const s = new TouchScroller({
		rowHeight: () => 20,
		scrollLines: (n) => scrolled.push(n),
		frame: (cb) => frames.push(cb),
		cancelFrame: () => undefined,
	});
	return { s, scrolled, frames };
}

describe("a finger on the terminal", () => {
	it("is a tap until it moves past the slop", () => {
		const { s, scrolled } = scroller();
		s.start(100, 0);
		s.move(100 + TAP_SLOP_PX - 1, 10);
		s.end(20);
		expect(s.moved).toBe(false);
		expect(scrolled).toEqual([]);
	});

	it("scrolls one line per row dragged: down shows older output", () => {
		const { s, scrolled } = scroller();
		s.start(100, 0);
		s.move(110, 200);
		s.move(165, 400);
		expect(s.moved).toBe(true);
		expect(scrolled.reduce((a, b) => a + b, 0)).toBe(-3);
		s.move(105, 600);
		expect(scrolled.reduce((a, b) => a + b, 0)).toBe(0);
	});

	it("glides after a flick and slows to a stop; a slow lift does not glide", () => {
		const { s, scrolled, frames } = scroller();
		s.start(100, 0);
		s.move(200, 50);
		s.move(400, 100);
		const dragged = scrolled.length;
		s.end(110);
		let now = 110;
		while (frames.length > 0 && now < 10_000) {
			now += 16;
			frames.shift()?.(now);
		}
		expect(scrolled.length).toBeGreaterThan(dragged);
		expect(frames).toHaveLength(0);
		const slow = scroller();
		slow.s.start(100, 0);
		slow.s.move(140, 1_000);
		slow.s.end(1_500);
		expect(slow.frames).toHaveLength(0);
	});
});
