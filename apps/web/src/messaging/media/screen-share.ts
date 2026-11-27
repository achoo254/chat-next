// Asking the browser for the screen, for a screenshot or a screen recording
// from the attach menu. Kept tiny and in the composer's chunk: the browser
// grants getDisplayMedia only inside the click that asked for it, so the
// request starts here, before the capture code (screen-capture.ts) loads.

/** Whether this browser can share the screen (desktop browsers; not phones or the app's WebView). */
export function canShareScreen(): boolean {
	return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/** Whether this browser can also record what it shares. */
export function canRecordScreen(): boolean {
	return canShareScreen() && typeof MediaRecorder !== "undefined";
}

/**
 * Opens the browser's screen picker. `audio` asks for the tab's or the
 * system's sound too, where the browser offers it. Call it from the click.
 */
export function requestScreen(audio: boolean): Promise<MediaStream> {
	return navigator.mediaDevices.getDisplayMedia({ video: true, audio });
}

/** The person closed the picker or refused sharing: nothing to report. */
export function refusedShare(err: unknown): boolean {
	return err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
}
