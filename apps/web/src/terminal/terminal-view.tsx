// One terminal session on screen: xterm.js with the WebGL renderer (the DOM
// renderer when WebGL is missing or its context is lost), fitted to its box,
// Unicode 11 widths and clickable links. The link hands output bytes to the
// writer here and they go straight to xterm, never through React state: a
// small frame (a keystroke's echo) is written the moment it arrives; only
// large bursts are gathered and written once per animation frame. A frame
// counts as written (and is acknowledged to the machine) when xterm's write
// callback runs, so a flood paces the machine instead of the page.
// On a machine that opens a session at its screen as it is now (a LiveSnapshot), the history from before
// loads as the user scrolls up past the top, into a read-only terminal above the live one (history-pane.ts,
// history-scroll.ts); a key always brings the view back to the live terminal's newest line.
// Loaded lazily with the dock; xterm never reaches the app's first chunk.
import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import { watchHistoryClears } from "./history-clears.ts";
import { HistoryPane } from "./history-pane.ts";
import { HistoryScroll } from "./history-scroll.ts";
import type { LatencyProbe } from "./latency-probe.ts";
import { TouchScroller } from "./touch-scroll.ts";
import { isTerminalReport } from "./terminal-reports.ts";
import { noAutofill } from "./no-autofill.ts";
import { openWebLink } from "./open-web-link.ts";
import { keepScrollbarVisible } from "./terminal-scrollbar.ts";
import { showTouchThumb } from "./terminal-touch-thumb.ts";
import { FONT, FONT_SIZE_DEFAULT, FONT_SIZE_TOUCH, fontSize, onFontSize, textOptions, waitForFont } from "./terminal-font.ts";
import type { TerminalLink } from "./terminal-link.ts";
import { showCursorWithoutFocus } from "./terminal-cursor.ts";
import { TerminalLoading } from "./terminal-loading.tsx";
import { OpeningGate } from "./terminal-opening.ts";
import { PreviewCover } from "./terminal-preview.ts";
import { copyWithContext, rememberCopy } from "../advisor/advisor-context.tsx";

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
	/** What the pane says until its terminal is drawn (the dock's own opening screen says the same). */
	openingLabel?: string;
	/** What the chip over the machine's preview says while the replay catches up. */
	syncingLabel?: string;
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


/** DECTCEM off, written after the program's last output so nothing it printed shows the caret again. */
const HIDE_CURSOR = new TextEncoder().encode("\x1b[?25l");

const encoder = new TextEncoder();

export function TerminalView({ link, session, focused, touch, label, latestLabel = "", openingLabel = "", syncingLabel = "", probe, onFocus, onTitle, onExit, onGone, onShortcut, register }: TerminalViewProps) {
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
	const focusedNow = useEffectEvent(() => focused);
	const syncingNow = useEffectEvent(() => syncingLabel);
	const historyCopy = useMachinesCopy().terminal.history;
	const historyLabels = useEffectEvent(() => historyCopy);
	// Until the terminal is drawn the pane keeps the opening screen: it then shows ready to type, never empty or mid-redraw.
	const [opening, setOpening] = useState(true);

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
			const gate = new OpeningGate(() => {
				if (!alive) return;
				setOpening(false);
				term.scrollToBottom();
				if (focusedNow() && !touch) term.focus();
			});
			// A fresh attach of a long session: the machine's rendering shows at once, the replay out of sight.
			const cover = new PreviewCover({
				host,
				real: () => term.element,
				showReal: () => {
					term.scrollToBottom();
					// The pane in use keeps the keyboard as the cover goes.
					if (focusedNow() && !touch) term.focus();
				},
				options: () => ({ ...textOptions(term.options.fontSize ?? fontSize(fallbackSize)), allowProposedApi: true }),
				size: () => ({ cols: term.cols, rows: term.rows }),
				focusReal: () => {
					if (!touch) term.focus();
				},
				label: syncingNow(),
			});
			// One row's height as drawn (the screen element's height over its rows), the box's share before the first draw.
			const rowHeight = () => {
				const drawn = term.element?.querySelector<HTMLElement>(".xterm-screen")?.offsetHeight ?? 0;
				return (drawn > 0 ? drawn : host.clientHeight) / Math.max(1, term.rows);
			};
			// The history from before the screen this pane opened at, above the live terminal.
			const history = new HistoryPane({
				host,
				options: () => ({ ...textOptions(term.options.fontSize ?? fontSize(fallbackSize)), allowProposedApi: true }),
				cols: () => term.cols,
				rows: () => term.rows,
				load: (life, beforeRow, maxRows) => link.history(session, life, beforeRow, maxRows),
				labels: () => historyLabels(),
				changed: () => scroll.layout(),
				focusLive: () => {
					if (!touch) term.focus();
				},
			});
			const scroll = new HistoryScroll({ live: term, pane: history, rowHeight });
			const onWheel = (event: WheelEvent) => scroll.wheel(event);
			// Before xterm sees it: past the top of the live terminal's history, the wheel scrolls the history pane.
			host.addEventListener("wheel", onWheel, { capture: true, passive: false });
			let frame = 0;
			const fitNow = () => {
				frame = 0;
				if (host.clientWidth === 0 || host.clientHeight === 0) return;
				try {
					fit.fit();
				} catch {
					// Not measurable yet (hidden): the next resize fits it.
				}
				scroll.layout();
			};
			const fitSoon = () => {
				if (frame === 0) frame = requestAnimationFrame(fitNow);
			};
			const detach = link.attach(session, {
				snapshot: (snap) => {
					writer.reset();
					term.reset();
					if (term.cols !== snap.cols || term.rows !== snap.rows) term.resize(snap.cols, snap.rows);
					term.write(snap.vt, () => {
						// A replayed screen (or one rebuilt mid-stream) holds its own history: none to load above it.
						history.off();
						fitSoon();
						gate.content();
					});
				},
				liveSnapshot: (live) => {
					// The screen as it is now: no replay to wait for, no cover; the pane shows it and takes keys once written.
					writer.reset();
					cover.dispose();
					scroll.toLive();
					term.reset();
					if (term.cols !== live.cols || term.rows !== live.rows) term.resize(live.cols, live.rows);
					term.write(live.vt, () => {
						history.start(live.epoch, live.historyEnd);
						fitSoon();
						gate.open();
					});
				},
				output: (data, done) => {
					// Quiet is counted from when xterm wrote the output, not when it arrived: a backlog still redraws.
					writer.write(data, () => {
						cover.output();
						gate.content();
						done();
					});
				},
				preview: (preview) => {
					cover.show(preview);
					// The preview is the session drawn: the pane shows it, and takes the keyboard, at once.
					gate.open();
				},
				caughtUp: () => cover.caughtUp(),
				exit: (code) => {
					// The program is gone: no caret, blinking or still, however the pane was focused or touched.
					term.options.cursorBlink = false;
					term.options.cursorInactiveStyle = "none";
					writer.write(HIDE_CURSOR, () => undefined);
					gate.open();
					exited(code);
				},
				gone: () => gone(),
			});
			const subscriptions = [
				term.onData((data) => {
					// What the user typed, pasted or composed brings the newest line into view; xterm's own reports
					// (focus, mouse, answers to the program) go to the program and leave the view where it is.
					if (!isTerminalReport(data)) {
						scroll.toLive();
						claimSize();
						probe?.key(session);
					}
					link.input(session, encoder.encode(data));
				}),
				// Mouse reports in X10 mode: one byte per character.
				term.onBinary((data) => link.input(session, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))),
				term.onResize(({ cols, rows }) => {
					link.resize(session, cols, rows);
					history.refit();
				}),
				term.onTitleChange((text) => title(text)),
				// A program cleared its history: the rows from before it go too.
				watchHistoryClears(term, () => history.cleared()),
				keepScrollbarVisible(host, term),
				// ⌘C / Ctrl+C through the browser: xterm's selection is not the page's, so Advisor is told here.
				rememberCopies(host, () => term.getSelection()),
				// A finger has no hover or drag on xterm's hairline bar: it gets a thumb and a way back to the newest line.
				...(touch ? [showTouchThumb(host, term, latestNow())] : []),
			];
			term.attachCustomKeyEventHandler((event) => {
				// Ctrl+Shift+C copies the selection (Ctrl+C alone stays the program's interrupt); with nothing selected it does nothing.
				// The selection in this terminal, else one in the history above it (the keyboard stays here).
				if (event.type === "keydown" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyC") {
					event.preventDefault();
					const selected = term.getSelection() || history.selection();
					if (selected !== "") void copyWithContext(selected, host);
					return false;
				}
				// ⌘C copies this terminal's selection through the browser; one in the history is copied here.
				if (event.type === "keydown" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "KeyC" && !term.hasSelection()) {
					const selected = history.selection();
					if (selected !== "") {
						event.preventDefault();
						void copyWithContext(selected, host);
						return false;
					}
				}
				return !(event.type === "keydown" && shortcut(event));
			});
			const observer = new ResizeObserver(fitSoon);
			observer.observe(host);
			// A finger scrolls the terminal itself (touch-scroll.ts): the history of the normal screen, or arrow
			// keys for a full-screen program (its own screen has no history), as xterm does for a mouse wheel.
			// While the preview covers the pane, a swipe moves nothing: the hidden terminal is not what the user sees.
			const stopTouch = touch ? touchScroll({ host, term, input: (seq) => link.input(session, encoder.encode(seq)), ref: scrollerRef, covered: () => cover.showing, scroll, rowHeight }) : () => undefined;
			// Ctrl/⌘ + − 0 here, or A−/A+ in the dock: every terminal of the page takes the new size.
			const stopSize = onFontSize((size) => {
				term.options.fontSize = size;
				webgl?.clearTextureAtlas();
				history.refit();
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
				// Called before the dock types into the pane: the view goes back to the newest line, as for a key here.
				claimSize: () => {
					scroll.toLive();
					claimSize();
				},
				caret: () => {
					if (term.cols === 0 || term.rows === 0) return null;
					const height = host.clientHeight / term.rows;
					const width = host.clientWidth / term.cols;
					const buffer = term.buffer.active;
					return { x: buffer.cursorX * width, y: buffer.cursorY * height, height };
				},
				text: screenText,
				// The dock's copy key: this terminal's selection, else one in the history above it.
				selection: () => term.getSelection() || history.selection(),
			});
			probe?.screen(session, screenText);
			cleanup = () => {
				registerHandle(null);
				probe?.screen(session, null);
				if (frame !== 0) cancelAnimationFrame(frame);
				observer.disconnect();
				stopTouch();
				host.removeEventListener("wheel", onWheel, { capture: true });
				stopClaims();
				stopSize();
				fonts?.removeEventListener("loadingdone", redraw);
				for (const s of subscriptions) s.dispose();
				detach();
				gate.dispose();
				cover.dispose();
				history.dispose();
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
	return (
		<>
			<div className="tx-term" ref={hostRef} onPointerDown={onPointerDown} onPointerUp={onPointerUp} />
			{opening && <TerminalLoading label={openingLabel} />}
		</>
	);
}

interface TouchScrollDeps {
	readonly host: HTMLElement;
	readonly term: Terminal;
	readonly input: (seq: string) => void;
	readonly ref: { current: TouchScroller | null };
	readonly covered: () => boolean;
	readonly scroll: HistoryScroll;
	readonly rowHeight: () => number;
}

/** Wires a TouchScroller to the pane's fingers; returns the cleanup. */
function touchScroll({ host, term, input, ref, covered, scroll, rowHeight }: TouchScrollDeps): () => void {
	const scroller = new TouchScroller({
		rowHeight,
		scrollLines: (lines) => {
			if (covered()) return;
			if (term.buffer.active.type === "alternate" && !scroll.inHistory) {
				const older = lines < 0;
				const code = older ? "A" : "B";
				input((term.modes.applicationCursorKeysMode ? `\x1bO${code}` : `\x1b[${code}`).repeat(Math.abs(lines)));
				// The live terminal's history, then past its top the history pane, as a wheel does.
			} else scroll.scroll(lines * rowHeight());
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

/** A copy event inside the terminal (bubbling from xterm's own field): Advisor keeps the terminal's selection. */
export function rememberCopies(host: HTMLElement, selection: () => string): { dispose(): void } {
	const onCopy = () => {
		rememberCopy(selection(), host);
	};
	host.addEventListener("copy", onCopy);
	return { dispose: () => host.removeEventListener("copy", onCopy) };
}
