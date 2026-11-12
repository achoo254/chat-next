// The terminal's text: the font (JetBrains Mono, self-hosted with its
// Vietnamese subset; fallbacks that also cover Vietnamese), the size the
// user picked (Ctrl/⌘ + − 0 in a terminal, A−/A+ in the dock; kept in this
// browser), and a calm palette whose every colour reads on the dark surface.

export const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono", monospace';

/**
 * Letters that live in the Vietnamese face of the font (fonts.css splits it
 * by unicode-range): loading with them fetches that face too, before xterm
 * draws its first glyph. A glyph drawn earlier would stay in the fallback
 * font for good (xterm caches glyphs).
 */
export const FONT_SAMPLE = "AaĐđƠơƯưẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹ";

export const FONT_SIZE_DEFAULT = 14;
export const FONT_SIZE_TOUCH = 13;
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;
/** Tall enough that capitals with two stacked marks (Ể Ộ Ữ) never touch the line above. */
export const LINE_HEIGHT = 1.35;
/** WCAG AA for body text: xterm lifts any colour (dim text too) that reads worse on its background. */
export const MIN_CONTRAST = 4.5;

const SIZE_KEY = "terminal:font-size";

/**
 * The 16 colours, calm but readable on #111318: every one but black (a
 * background colour) is at least 5.9:1 there, bright black (the grey of
 * Claude Code's notes) included; xterm's own bright black is 3.2:1.
 */
export const THEME = {
	background: "#111318",
	foreground: "#e6e8ee",
	cursor: "#e6e8ee",
	cursorAccent: "#111318",
	selectionBackground: "#3a4256",
	black: "#3b4252",
	red: "#f0787a",
	green: "#8fd18b",
	yellow: "#e8c66a",
	blue: "#7fa9f5",
	magenta: "#c79bf0",
	cyan: "#6ccfd8",
	white: "#d4d8e0",
	brightBlack: "#8a92a3",
	brightRed: "#ff9a9c",
	brightGreen: "#a8e3a3",
	brightYellow: "#f5d98c",
	brightBlue: "#9dbdfa",
	brightMagenta: "#dab8f7",
	brightCyan: "#8fe0e7",
	brightWhite: "#f5f7fa",
} as const;

/** xterm's options for the text: what makes Vietnamese and Claude Code's dim lines readable. */
export function textOptions(size: number) {
	return {
		fontFamily: FONT,
		fontSize: size,
		lineHeight: LINE_HEIGHT,
		letterSpacing: 0,
		fontWeight: 400,
		fontWeightBold: 600,
		minimumContrastRatio: MIN_CONTRAST,
		theme: THEME,
	} as const;
}

export function clampFontSize(size: number): number {
	return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

const listeners = new Set<(size: number) => void>();

/** The size picked in this browser; `fallback` when none was (or storage is refused). */
export function fontSize(fallback: number): number {
	try {
		const stored = Number(window.localStorage.getItem(SIZE_KEY));
		return Number.isFinite(stored) && stored > 0 ? clampFontSize(stored) : fallback;
	} catch {
		return fallback;
	}
}

/** Picks a size for every terminal of this browser (`null`: back to the default); returns the one in effect. */
export function setFontSize(size: number | null, fallback: number): number {
	const next = size === null ? fallback : clampFontSize(size);
	try {
		if (size === null) window.localStorage.removeItem(SIZE_KEY);
		else window.localStorage.setItem(SIZE_KEY, String(next));
	} catch {
		// Storage refused: the size holds for this page.
	}
	for (const fn of listeners) fn(next);
	return next;
}

/** Called with the new size whenever it changes. */
export function onFontSize(fn: (size: number) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The size change a key asks for in a terminal (Ctrl or ⌘ with + − 0), if it is one. */
export function fontKeyOf(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key" | "code">, mac: boolean): "bigger" | "smaller" | "reset" | null {
	const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (!mod || event.altKey) return null;
	if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "bigger";
	if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "smaller";
	if (event.key === "0" || event.code === "Numpad0") return "reset";
	return null;
}

/** Waits for both faces of the font (latin and Vietnamese, regular and bold) at `size`, at most `ms`. */
export function waitForFont(size: number, ms: number): Promise<void> {
	const fonts = typeof document === "undefined" ? undefined : document.fonts;
	if (fonts === undefined || typeof fonts.load !== "function") return Promise.resolve();
	const loads = ["400", "600"].map((weight) => fonts.load(`${weight} ${size}px "JetBrains Mono"`, FONT_SAMPLE).then(() => undefined, () => undefined));
	return Promise.race([Promise.all(loads).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}
