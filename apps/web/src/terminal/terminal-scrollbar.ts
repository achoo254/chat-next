// The terminal's scrollbar stays in view while there is history to scroll.
import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * xterm 6 draws its scrollbar as an overlay that fades out (opacity 0) a moment
 * after the last scroll or hover, so a terminal with thousands of lines of
 * history looks like it cannot scroll. terminal.css keeps the bar visible while
 * `data-scrollable` is set on the host; this sets it only when the normal
 * screen has scrollback, because xterm sizes the bar's thumb to the whole track
 * when there is nothing to scroll and a full-height thumb would be a lie.
 * (The alternate screen of a full-screen program has no history, so no bar.)
 */
export function keepScrollbarVisible(host: HTMLElement, term: Terminal): IDisposable {
	const update = () => {
		const buffer = term.buffer.active;
		if (buffer.type === "normal" && buffer.baseY > 0) host.setAttribute("data-scrollable", "");
		else host.removeAttribute("data-scrollable");
	};
	const subscriptions = [term.onWriteParsed(update), term.onScroll(update), term.onResize(update), term.buffer.onBufferChange(update)];
	update();
	return {
		dispose: () => {
			for (const s of subscriptions) s.dispose();
			host.removeAttribute("data-scrollable");
		},
	};
}
