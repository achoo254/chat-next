// One terminal session on screen: xterm.js with the WebGL renderer (the DOM
// renderer when WebGL is missing or its context is lost), fitted to its box,
// Unicode 11 widths and clickable links. The link hands output bytes to the
// writer here and they go straight to xterm, never through React state: a
// small frame (a keystroke's echo) is written the moment it arrives; only
// large bursts are gathered and written once per animation frame. A frame
// counts as written (and is acknowledged to the machine) when xterm's write
// callback runs, so a flood paces the machine instead of the page.
// Loaded lazily with the dock; xterm never reaches the app's first chunk.
import { useEffect, useEffectEvent, useRef, type PointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { LatencyProbe } from "./latency-probe.ts";
import { TouchScroller } from "./touch-scroll.ts";
import { noAutofill } from "./no-autofill.ts";
import { openWebLink } from "./open-web-link.ts";
import { keepScrollbarVisible } from "./terminal-scrollbar.ts";
import { showTouchThumb } from "./terminal-touch-thumb.ts";
import { FONT, FONT_SIZE_DEFAULT, FONT_SIZE_TOUCH, fontSize, onFontSize, textOptions, waitForFont } from "./terminal-font.ts";
import type { TerminalLink } from "./terminal-link.ts";
import { showCursorWithoutFocus } from "./terminal-cursor.ts";

/** Output smaller than this is written at once. */
const SMALL_WRITE = 4 * 1024;
/** Bytes handed to xterm and not parsed yet beyond which output waits for the next frame. */
const BUSY_BYTES = 256 * 1024;
/** Waiting for the web font before measuring cells, at most; a face that comes later redraws the screen. */
const FONT_WAIT_MS = 1_500;

/** What the dock asks of a pane: the keyboard, the cursor mode the arrows need, and where the caret is. */
/** The device in use sends its size again at most this often while typing or touching. */
const CLAIM_EVERY_MS = 1_000;

export interface PaneHandle {
	focus(): void;
	/** DECCKM: arrows send ESC O x instead of ESC [ x. */
	appCursor(): boolean;
	/** The program asked for pastes in brackets (Claude Code does). */
	bracketedPaste(): boolean;
	/** Sends this pane's size again before typing from the dock (another device may have resized the session). */
	claimSize(): void;
	/** The caret's position in the pane, in CSS pixels. */
	caret(): { readonly x: number; readonly y: number; readonly height: number } | null;
	/** The pane's text, scrollback included: what the program printed before it exited. */
	text(): string;
	/** The text selected in the pane, "" when none. */
	selection(): string;
}

export interface TerminalViewProps {
	link: TerminalLink;
	session: number;
	/** This pane has the keyboard. */
	focused: boolean;
	/** A touch screen: typing goes through the dock's own input (IME), not xterm's. */
	touch: boolean;
	label: string;
	/** Names the touch screen's "back to the newest output" button. */
	latestLabel?: string;
	probe: LatencyProbe | null;
	onFocus(): void;
	onTitle(title: string): void;
	onExit(code: number): void;
	onGone(): void;
	/** A dock shortcut; true when it handled the key (xterm then ignores it). */
	onShortcut(event: KeyboardEvent): boolean;
	register(handle: PaneHandle | null): void;
}

/**
 * Writes output into xterm: small frames now, bursts batched per frame.
 * Each frame's `done` runs once xterm has parsed it.
 */
class OutputWriter {
	private batch: Uint8Array[] = [];
	private dones: (() => void)[] = [];
	private batchBytes = 0;
	private inFlight = 0;
	/** The pending flush: an animation frame, or a timeout while the page is hidden. */
	private scheduled: { kind: "frame" | "timeout"; id: number } | null = null;
	private disposed = false;

	constructor(
		private readonly term: Terminal,
		private readonly session: number,
		private readonly probe: LatencyProbe | null,
	) {}

	write(data: Uint8Array, done: () => void): void {
		if (this.disposed) return;
		if (this.batch.length === 0 && data.length < SMALL_WRITE && this.inFlight < BUSY_BYTES) {
			const start = this.probe?.take(this.session) ?? null;
			this.inFlight += data.length;
			this.term.write(data, () => {
				this.inFlight -= data.length;
				if (start !== null) this.probe?.written(start);
				done();
			});
			return;
		}
		this.batch.push(data);
		this.dones.push(done);
		this.batchBytes += data.length;
		this.schedule();
	}

	/** Output from before a snapshot must not land after it. */
	reset(): void {
		this.batch = [];
		this.dones = [];
		this.batchBytes = 0;
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
		const pending = this.scheduled;
		this.scheduled = null;
		if (pending?.kind === "frame") cancelAnimationFrame(pending.id);
		else if (pending?.kind === "timeout") window.clearTimeout(pending.id);
	}

	private schedule(): void {
		if (this.scheduled !== null) return;
		const run = () => {
			this.scheduled = null;
			this.flush();
		};
		// A hidden page gets no animation frames; output still has to move (and be acknowledged).
		this.scheduled =
			document.visibilityState === "hidden" ? { kind: "timeout", id: window.setTimeout(run, 16) } : { kind: "frame", id: requestAnimationFrame(run) };
	}

	private flush(): void {
		if (this.disposed || this.batch.length === 0) return;
		const parts = this.batch;
		const dones = this.dones;
		const size = this.batchBytes;
		this.reset();
		const joined = new Uint8Array(size);
		let at = 0;
		for (const part of parts) {
			joined.set(part, at);
			at += part.length;
		}
		this.inFlight += size;
		this.term.write(joined, () => {
			this.inFlight -= size;
			for (const done of dones) done();
		});
	}
}


const encoder = new TextEncoder();

export function TerminalView({ link, session, focused, touch, label, latestLabel = "", probe, onFocus, onTitle, onExit, onGone, onShortcut, register }: TerminalViewProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const scrollerRef = useRef<TouchScroller | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const title = useEffectEvent((text: string) => onTitle(text));
	const exited = useEffectEvent((code: number) => onExit(code));
	const gone = useEffectEvent(() => onGone());
	const shortcut = useEffectEvent((event: KeyboardEvent) => onShortcut(event));
	const registerHandle = useEffectEvent((handle: PaneHandle | null) => register(handle));
	const labelNow = useEffectEvent(() => label);
	const latestNow = useEffectEvent(() => latestLabel);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let alive = true;
		let cleanup: () => void = () => undefined;
		const fallbackSize = touch ? FONT_SIZE_TOUCH : FONT_SIZE_DEFAULT;
		void waitForFont(fontSize(fallbackSize), FONT_WAIT_MS).then(() => {
			if (!alive) return;
			const term = new Terminal({
				// Unicode 11 widths are a proposed API in xterm 6.
				allowProposedApi: true,
				...textOptions(fontSize(fallbackSize)),
				// The owner's rule: no line of a session's history is cut, here or on the machine (which replays every
				// byte since the session opened). xterm needs a finite cap; it allocates rows only as output fills them,
				// so memory grows with real output, not with this number.
				scrollback: 1_000_000,
				cursorBlink: true,
				macOptionIsMeta: true,
				// A link a program sets itself (OSC 8) opens as a plain one does, without xterm's own confirm box.
				linkHandler: {
					allowNonHttpProtocols: false,
					activate: (event, uri) => {
						event.preventDefault();
						openWebLink(uri);
					},
				},
			});
			termRef.current = term;
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.loadAddon(new Unicode11Addon());
			term.unicode.activeVersion = "11";
			term.loadAddon(
				new WebLinksAddon((event, uri) => {
					event.preventDefault();
					openWebLink(uri);
				}),
			);
			term.open(host);
			let webgl: WebglAddon | null = null;
			try {
				const addon = new WebglAddon();
				addon.onContextLoss(() => {
					addon.dispose();
					webgl = null;
				});
				term.loadAddon(addon);
				webgl = addon;
			} catch {
				// No WebGL2 here: xterm keeps its DOM renderer.
			}
			// A face that arrives after the first draw (slow network, the bold one): measure the cells again and
			// drop the glyphs already drawn in a fallback font.
			const redraw = () => {
				term.options.fontFamily = FONT;
				webgl?.clearTextureAtlas();
				term.refresh(0, term.rows - 1);
				fitSoon();
			};
			const fonts = typeof document === "undefined" ? undefined : document.fonts;
			fonts?.addEventListener("loadingdone", redraw);
			const textarea = term.textarea;
			if (textarea !== undefined) {
				// Keystrokes, never a credential: no password manager popup at the cursor.
				noAutofill(textarea);
				textarea.setAttribute("aria-label", labelNow());
				if (touch) {
					// On a touch screen the dock's own input takes the keyboard (IME composition, the key bar).
					textarea.readOnly = true;
					textarea.setAttribute("inputmode", "none");
					textarea.tabIndex = -1;
					showCursorWithoutFocus(term);
				}
			}
			const writer = new OutputWriter(term, session, probe);
			let frame = 0;
			const fitNow = () => {
				frame = 0;
				if (host.clientWidth === 0 || host.clientHeight === 0) return;
				try {
					fit.fit();
				} catch {
					// Not measurable yet (hidden): the next resize fits it.
				}
			};
			const fitSoon = () => {
				if (frame === 0) frame = requestAnimationFrame(fitNow);
			};
			const detach = link.attach(session, {
				snapshot: (snap) => {
					writer.reset();
					term.reset();
					if (term.cols !== snap.cols || term.rows !== snap.rows) term.resize(snap.cols, snap.rows);
					term.write(snap.vt, fitSoon);
				},
				output: (data, done) => writer.write(data, done),
				exit: (code) => exited(code),
				gone: () => gone(),
			});
			const subscriptions = [
				term.onData((data) => {
					claimSize();
					probe?.key(session);
					link.input(session, encoder.encode(data));
				}),
				// Mouse reports in X10 mode: one byte per character.
				term.onBinary((data) => link.input(session, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))),
				term.onResize(({ cols, rows }) => link.resize(session, cols, rows)),
				term.onTitleChange((text) => title(text)),
				keepScrollbarVisible(host, term),
				// A finger has no hover or drag on xterm's hairline bar: it gets a thumb and a way back to the newest line.
				...(touch ? [showTouchThumb(host, term, latestNow())] : []),
			];
			term.attachCustomKeyEventHandler((event) => {
				// Ctrl+Shift+C copies the selection (Ctrl+C alone stays the program's interrupt); with nothing selected it does nothing.
				if (event.type === "keydown" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyC") {
					event.preventDefault();
					const selected = term.getSelection();
					if (selected !== "") void navigator.clipboard?.writeText(selected).catch(() => undefined);
					return false;
				}
				return !(event.type === "keydown" && shortcut(event));
			});
			const observer = new ResizeObserver(fitSoon);
			observer.observe(host);
			// A finger scrolls the terminal itself (touch-scroll.ts): the history of the normal screen, or arrow
			// keys for a full-screen program (its own screen has no history), as xterm does for a mouse wheel.
			const stopTouch = touch ? touchScroll(host, term, (seq) => link.input(session, encoder.encode(seq)), scrollerRef) : () => undefined;
			// Ctrl/⌘ + − 0 here, or A−/A+ in the dock: every terminal of the page takes the new size.
			const stopSize = onFontSize((size) => {
				term.options.fontSize = size;
				webgl?.clearTextureAtlas();
				fitSoon();
			});
			fitNow();
			link.resize(session, term.cols, term.rows);
			// One session may be attached from several devices, and the machine takes the size last sent: the device in
			// use sends its size again (when the page shows or gets the focus, on a touch, before typing), so the program
			// draws for this screen and not another device's width. An unchanged size wakes nothing on the machine.
			let claimedAt = 0;
			const claimSize = (force = false) => {
				const now = performance.now();
				if (!force && now - claimedAt < CLAIM_EVERY_MS) return;
				claimedAt = now;
				link.resize(session, term.cols, term.rows, true);
			};
			const onShow = () => {
				if (document.visibilityState === "visible") claimSize(true);
			};
			const onFocus = () => claimSize(true);
			const onTouch = () => claimSize();
			document.addEventListener("visibilitychange", onShow);
			window.addEventListener("focus", onFocus);
			host.addEventListener("pointerdown", onTouch);
			const stopClaims = () => {
				document.removeEventListener("visibilitychange", onShow);
				window.removeEventListener("focus", onFocus);
				host.removeEventListener("pointerdown", onTouch);
			};
			const screenText = () => {
				const buffer = term.buffer.active;
				const lines: string[] = [];
				for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
				return lines.join("\n").trimEnd();
			};
			registerHandle({
				focus: () => term.focus(),
				appCursor: () => term.modes.applicationCursorKeysMode,
				bracketedPaste: () => term.modes.bracketedPasteMode,
				claimSize: () => claimSize(),
				caret: () => {
					if (term.cols === 0 || term.rows === 0) return null;
					const height = host.clientHeight / term.rows;
					const width = host.clientWidth / term.cols;
					const buffer = term.buffer.active;
					return { x: buffer.cursorX * width, y: buffer.cursorY * height, height };
				},
				text: screenText,
				selection: () => term.getSelection(),
			});
			probe?.screen(session, screenText);
			cleanup = () => {
				registerHandle(null);
				probe?.screen(session, null);
				if (frame !== 0) cancelAnimationFrame(frame);
				observer.disconnect();
				stopTouch();
				stopClaims();
				stopSize();
				fonts?.removeEventListener("loadingdone", redraw);
				for (const s of subscriptions) s.dispose();
				detach();
				writer.dispose();
				termRef.current = null;
				term.dispose();
			};
		});
		return () => {
			alive = false;
			cleanup();
		};
	}, [link, session, touch, probe]);

	useEffect(() => {
		if (focused && !touch) termRef.current?.focus();
	}, [focused, touch]);

	// The program's title names the terminal for screen readers.
	useEffect(() => {
		termRef.current?.textarea?.setAttribute("aria-label", label);
	}, [label]);

	// A finger on a touch screen: no emulated mousedown follows, so xterm never takes the focus for its own
	// read-only field and the phone keyboard stays with the dock's input (focused on pointerup).
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (touch && event.pointerType !== "mouse") event.preventDefault();
		onFocus();
	};
	// A swipe was a scroll: the pane does not take it for a tap (no keyboard).
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (scrollerRef.current?.moved === true) event.stopPropagation();
	};
	return <div className="tx-term" ref={hostRef} onPointerDown={onPointerDown} onPointerUp={onPointerUp} />;
}

/** Wires a TouchScroller to the pane's fingers; returns the cleanup. */
function touchScroll(host: HTMLElement, term: Terminal, input: (seq: string) => void, ref: { current: TouchScroller | null }): () => void {
	const scroller = new TouchScroller({
		rowHeight: () => host.clientHeight / Math.max(1, term.rows),
		scrollLines: (lines) => {
			if (term.buffer.active.type === "alternate") {
				const older = lines < 0;
				const code = older ? "A" : "B";
				input((term.modes.applicationCursorKeysMode ? `\x1bO${code}` : `\x1b[${code}`).repeat(Math.abs(lines)));
			} else term.scrollLines(lines);
		},
	});
	ref.current = scroller;
	const finger = (event: globalThis.PointerEvent) => event.pointerType !== "mouse" && event.isPrimary;
	const down = (event: globalThis.PointerEvent) => {
		if (finger(event)) scroller.start(event.clientY, event.timeStamp);
	};
	const move = (event: globalThis.PointerEvent) => {
		if (finger(event)) scroller.move(event.clientY, event.timeStamp);
	};
	const up = (event: globalThis.PointerEvent) => {
		if (finger(event)) scroller.end(event.timeStamp);
	};
	host.addEventListener("pointerdown", down);
	host.addEventListener("pointermove", move);
	host.addEventListener("pointerup", up);
	host.addEventListener("pointercancel", up);
	return () => {
		scroller.stop();
		ref.current = null;
		host.removeEventListener("pointerdown", down);
		host.removeEventListener("pointermove", move);
		host.removeEventListener("pointerup", up);
		host.removeEventListener("pointercancel", up);
	};
}
