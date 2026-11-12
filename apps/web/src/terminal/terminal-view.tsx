// One terminal session on screen: xterm.js with the WebGL renderer (the DOM
// renderer when WebGL is missing or its context is lost), fitted to its box,
// Unicode 11 widths and clickable links. The link hands output bytes to the
// writer here and they go straight to xterm, never through React state: a
// small frame (a keystroke's echo) is written the moment it arrives; only
// large bursts are gathered and written once per animation frame. A frame
// counts as written (and is acknowledged to the machine) when xterm's write
// callback runs, so a flood paces the machine instead of the page.
// Loaded lazily with the dock; xterm never reaches the app's first chunk.
import { useEffect, useEffectEvent, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { LatencyProbe } from "./latency-probe.ts";
import { noAutofill } from "./no-autofill.ts";
import { FONT, FONT_SIZE_DEFAULT, FONT_SIZE_TOUCH, fontSize, onFontSize, textOptions, waitForFont } from "./terminal-font.ts";
import type { TerminalLink } from "./terminal-link.ts";

/** Output smaller than this is written at once. */
const SMALL_WRITE = 4 * 1024;
/** Bytes handed to xterm and not parsed yet beyond which output waits for the next frame. */
const BUSY_BYTES = 256 * 1024;
/** Waiting for the web font before measuring cells, at most; a face that comes later redraws the screen. */
const FONT_WAIT_MS = 1_500;

/** What the dock asks of a pane: the keyboard, the cursor mode the arrows need, and where the caret is. */
export interface PaneHandle {
	focus(): void;
	/** DECCKM: arrows send ESC O x instead of ESC [ x. */
	appCursor(): boolean;
	/** The caret's position in the pane, in CSS pixels. */
	caret(): { readonly x: number; readonly y: number; readonly height: number } | null;
}

export interface TerminalViewProps {
	link: TerminalLink;
	session: number;
	/** This pane has the keyboard. */
	focused: boolean;
	/** A touch screen: typing goes through the dock's own input (IME), not xterm's. */
	touch: boolean;
	label: string;
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

export function TerminalView({ link, session, focused, touch, label, probe, onFocus, onTitle, onExit, onGone, onShortcut, register }: TerminalViewProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const title = useEffectEvent((text: string) => onTitle(text));
	const exited = useEffectEvent((code: number) => onExit(code));
	const gone = useEffectEvent(() => onGone());
	const shortcut = useEffectEvent((event: KeyboardEvent) => onShortcut(event));
	const registerHandle = useEffectEvent((handle: PaneHandle | null) => register(handle));
	const labelNow = useEffectEvent(() => label);

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
				scrollback: 5_000,
				cursorBlink: true,
				macOptionIsMeta: true,
			});
			termRef.current = term;
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.loadAddon(new Unicode11Addon());
			term.unicode.activeVersion = "11";
			term.loadAddon(
				new WebLinksAddon((event, uri) => {
					event.preventDefault();
					window.open(uri, "_blank", "noopener,noreferrer");
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
					probe?.key(session);
					link.input(session, encoder.encode(data));
				}),
				// Mouse reports in X10 mode: one byte per character.
				term.onBinary((data) => link.input(session, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))),
				term.onResize(({ cols, rows }) => link.resize(session, cols, rows)),
				term.onTitleChange((text) => title(text)),
			];
			term.attachCustomKeyEventHandler((event) => !(event.type === "keydown" && shortcut(event)));
			const observer = new ResizeObserver(fitSoon);
			observer.observe(host);
			// Ctrl/⌘ + − 0 here, or A−/A+ in the dock: every terminal of the page takes the new size.
			const stopSize = onFontSize((size) => {
				term.options.fontSize = size;
				webgl?.clearTextureAtlas();
				fitSoon();
			});
			fitNow();
			link.resize(session, term.cols, term.rows);
			registerHandle({
				focus: () => term.focus(),
				appCursor: () => term.modes.applicationCursorKeysMode,
				caret: () => {
					if (term.cols === 0 || term.rows === 0) return null;
					const height = host.clientHeight / term.rows;
					const width = host.clientWidth / term.cols;
					const buffer = term.buffer.active;
					return { x: buffer.cursorX * width, y: buffer.cursorY * height, height };
				},
			});
			probe?.screen(session, () => {
				const buffer = term.buffer.active;
				const lines: string[] = [];
				for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
				return lines.join("\n").trimEnd();
			});
			cleanup = () => {
				registerHandle(null);
				probe?.screen(session, null);
				if (frame !== 0) cancelAnimationFrame(frame);
				observer.disconnect();
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

	return <div className="tx-term" ref={hostRef} onPointerDown={onFocus} />;
}
