// A touch screen types through the dock's own input, so xterm never sees a key
// or the focus: its cursor is turned on without them, as a block.
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { showCursorWithoutFocus } from "../../src/terminal/terminal-cursor.ts";

function fakeTerm(core: unknown) {
	const refresh = vi.fn();
	const term = { options: {} as { cursorInactiveStyle?: string }, rows: 24, refresh, _core: core };
	return { term, refresh, asTerminal: term as unknown as Terminal };
}

describe("the terminal's cursor on a touch screen", () => {
	it("is on before any key or focus, drawn as a block, and the screen redraws", () => {
		const coreService = { isCursorInitialized: false };
		const { term, refresh, asTerminal } = fakeTerm({ coreService });
		showCursorWithoutFocus(asTerminal);
		expect(coreService.isCursorInitialized).toBe(true);
		expect(term.options.cursorInactiveStyle).toBe("block");
		expect(refresh).toHaveBeenCalledWith(0, 23);
	});

	it("an xterm without that inner flag keeps working as it was (the block style only)", () => {
		const { term, refresh, asTerminal } = fakeTerm(undefined);
		showCursorWithoutFocus(asTerminal);
		expect(term.options.cursorInactiveStyle).toBe("block");
		expect(refresh).not.toHaveBeenCalled();
	});
});
