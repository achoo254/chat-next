// A program clearing its history in the live terminal: ED 3 in any spelling on the normal screen, or a full
// reset, clears the history loaded from before; ED 3 on a full-screen program's own screen does not, nor do the
// other erases. xterm keeps its own handling of each (the handlers return false).
import { describe, expect, it } from "vitest";
import { watchHistoryClears, type ParsingTerminal } from "../../src/terminal/history-clears.ts";

type Csi = (params: (number | number[])[]) => boolean;

/** A parser that keeps the handlers registered, for the test to call as xterm would. */
function fakeTerm() {
	const csi = new Map<string, Csi>();
	let esc: (() => boolean) | null = null;
	const active = { type: "normal" };
	const term = {
		buffer: { active },
		parser: {
			registerCsiHandler: (id: { prefix?: string; final: string }, handler: Csi) => {
				csi.set(`${id.prefix ?? ""}${id.final}`, handler);
				return { dispose: () => csi.delete(`${id.prefix ?? ""}${id.final}`) };
			},
			registerEscHandler: (id: { final: string }, handler: () => boolean) => {
				if (id.final === "c") esc = handler;
				return { dispose: () => (esc = null) };
			},
		},
	} as unknown as ParsingTerminal;
	return {
		term,
		active,
		csi: (key: string, params: (number | number[])[]) => csi.get(key)?.(params),
		ris: () => esc?.(),
		count: () => csi.size + (esc === null ? 0 : 1),
	};
}

describe("a program clearing its history", () => {
	it("clears on ED 3 in every spelling on the normal screen, and on a full reset", () => {
		const t = fakeTerm();
		let cleared = 0;
		const watch = watchHistoryClears(t.term, () => (cleared += 1));
		// ESC[3J, ESC[03J (the parser reads 3), ESC[3;J, ESC[?3J, a sub-parameter form.
		expect(t.csi("J", [3])).toBe(false);
		t.csi("J", [3, 0]);
		t.csi("?J", [3]);
		t.csi("J", [[3]]);
		expect(cleared).toBe(4);
		expect(t.ris()).toBe(false);
		expect(cleared).toBe(5);
		// Other erases keep the history.
		t.csi("J", [0]);
		t.csi("J", [2]);
		t.csi("J", [1, 3]);
		expect(cleared).toBe(5);
		watch.dispose();
		expect(t.count()).toBe(0);
	});

	it("leaves the history alone for ED 3 on a full-screen program's own screen; a reset still clears", () => {
		const t = fakeTerm();
		let cleared = 0;
		watchHistoryClears(t.term, () => (cleared += 1));
		t.active.type = "alternate";
		t.csi("J", [3]);
		t.csi("?J", [3]);
		expect(cleared).toBe(0);
		t.ris();
		expect(cleared).toBe(1);
	});
});
