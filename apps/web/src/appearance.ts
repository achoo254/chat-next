// Appearance kept on this device (mockups/settings.html#appearance): light,
// dark or system theme, and the size of message text. Applied before the
// first render so the page does not flash in the wrong theme.
export type Theme = "light" | "dark" | "system";

const THEME_KEY = "app:theme";
const FONT_KEY = "app:message-font";
export const FONT_MIN = 13;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 15;

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Storage off: the choice lasts until the tab closes.
	}
}

export function storedTheme(): Theme {
	const value = read(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
}

export function storedFontSize(): number {
	const value = Number(read(FONT_KEY));
	return Number.isInteger(value) && value >= FONT_MIN && value <= FONT_MAX ? value : FONT_DEFAULT;
}

function applyTheme(theme: Theme): void {
	if (theme === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
}

function applyFontSize(px: number): void {
	if (px === FONT_DEFAULT) document.documentElement.style.removeProperty("--msg-font");
	else document.documentElement.style.setProperty("--msg-font", `${px / 16}rem`);
}

export function setTheme(theme: Theme): void {
	write(THEME_KEY, theme);
	applyTheme(theme);
}

export function setFontSize(px: number): void {
	const clamped = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, px)));
	write(FONT_KEY, String(clamped));
	applyFontSize(clamped);
}

/** Puts the stored theme and text size on <html>; run once before rendering. */
export function applyStoredAppearance(): void {
	applyTheme(storedTheme());
	applyFontSize(storedFontSize());
}
