// What a finger sees of a terminal's history on a touch screen: a slim thumb
// along the right edge (faint while there is history, brighter while it
// scrolls) and, once scrolled away from the newest output, a round button that
// goes back to it. xterm's own overlay bar is a hairline that fades out and
// cannot be dragged on a phone, so on a touch screen this replaces it.
import type { IDisposable, Terminal } from "@xterm/xterm";

/** The thumb never gets shorter than this, so a long history still leaves something to see. */
const MIN_THUMB_PX = 36;
/** Space kept above and below the thumb. */
const INSET_PX = 4;
/** How long the thumb stays bright after the last scroll. */
const ACTIVE_MS = 1200;

export interface ThumbGeometry {
	/** There is history to scroll. */
	readonly visible: boolean;
	readonly height: number;
	/** Distance from the top of the track. */
	readonly top: number;
}

/**
 * The thumb for a screen of `rows` over `baseY` lines of history, `viewportY`
 * lines down from the oldest, in a track `track` pixels high.
 */
export function thumbGeometry(rows: number, baseY: number, viewportY: number, track: number): ThumbGeometry {
	if (baseY <= 0 || track <= 0 || rows <= 0) return { visible: false, height: 0, top: 0 };
	const height = Math.min(track, Math.max(MIN_THUMB_PX, (track * rows) / (baseY + rows)));
	const place = Math.min(1, Math.max(0, viewportY / baseY));
	return { visible: true, height, top: (track - height) * place };
}

/** Lines as the button shows them: whole up to 999, then thousands with one decimal ("1.2k"). */
export function formatLines(lines: number): string {
	if (lines < 1000) return String(Math.max(0, Math.round(lines)));
	return `${(lines / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** Adds the thumb and the "back to the newest" button to `host`; `latestLabel` names the button. */
export function showTouchThumb(host: HTMLElement, term: Terminal, latestLabel: string): IDisposable {
	const thumb = document.createElement("div");
	thumb.className = "tx-thumb";
	thumb.setAttribute("aria-hidden", "true");
	const latest = document.createElement("button");
	latest.type = "button";
	latest.className = "tx-latest";
	latest.hidden = true;
	const count = document.createElement("span");
	count.className = "tx-latest-n";
	latest.append(count);
	latest.setAttribute("aria-label", latestLabel);
	latest.title = latestLabel;
	// A tap on the button is not a scroll of the pane nor a tap that brings the keyboard up.
	const stop = (event: Event) => event.stopPropagation();
	for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) latest.addEventListener(type, stop);
	latest.addEventListener("click", () => term.scrollToBottom());
	host.append(thumb, latest);

	let timer: number | undefined;
	let lastY = -1;
	let wasBottom = true;
	const flash = () => {
		thumb.setAttribute("data-active", "");
		window.clearTimeout(timer);
		timer = window.setTimeout(() => thumb.removeAttribute("data-active"), ACTIVE_MS);
	};
	const update = () => {
		const buffer = term.buffer.active;
		const shown = buffer.type === "normal";
		const geometry = thumbGeometry(term.rows, shown ? buffer.baseY : 0, buffer.viewportY, host.clientHeight - 2 * INSET_PX);
		if (geometry.visible) {
			thumb.style.height = `${geometry.height}px`;
			thumb.style.transform = `translateY(${INSET_PX + geometry.top}px)`;
			thumb.setAttribute("data-on", "");
		} else {
			thumb.removeAttribute("data-on");
			thumb.removeAttribute("data-active");
		}
		const atBottom = buffer.viewportY >= buffer.baseY;
		latest.hidden = !geometry.visible || atBottom;
		// How far the view is from the newest line, on the button itself.
		const away = Math.max(0, buffer.baseY - buffer.viewportY);
		count.textContent = formatLines(away);
		latest.setAttribute("aria-label", `${latestLabel} (${away})`);
		latest.title = `${latestLabel} (${away})`;
		// Output that scrolls along at the bottom does not flash it; a finger, or being away from the bottom, does.
		if (geometry.visible && buffer.viewportY !== lastY && !(atBottom && wasBottom)) flash();
		lastY = buffer.viewportY;
		wasBottom = atBottom;
	};
	const subscriptions = [term.onScroll(update), term.onWriteParsed(update), term.onResize(update), term.buffer.onBufferChange(update)];
	update();
	return {
		dispose: () => {
			for (const s of subscriptions) s.dispose();
			window.clearTimeout(timer);
			thumb.remove();
			latest.remove();
		},
	};
}
