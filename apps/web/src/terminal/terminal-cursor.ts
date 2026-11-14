// The caret of a terminal typed into from a touch screen's own input (see the function).
import type { Terminal } from "@xterm/xterm";

/**
 * xterm draws no cursor until its own field took the focus or a key, or the
 * program switched to the alternate screen. On a touch screen the dock's input
 * takes every key, so a program on the main screen (Claude Code's prompt) would
 * show no caret until a tap. The flag is xterm's internal one (6.0.0); without
 * it nothing changes. The caret is drawn as a block: that input is where the
 * keys go, so the terminal reads as the one typed into.
 */
export function showCursorWithoutFocus(term: Terminal): void {
	term.options.cursorInactiveStyle = "block";
	const core = (term as unknown as { _core?: { coreService?: { isCursorInitialized?: boolean } } })._core;
	if (core?.coreService === undefined) return;
	core.coreService.isCursorInitialized = true;
	term.refresh(0, term.rows - 1);
}
