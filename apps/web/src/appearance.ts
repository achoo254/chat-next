// Appearance (mockups/settings.html#appearance). The theme is the shared
// choice of every hoandat.com app (shared-theme.ts); the size of message
// text stays on this device.

/**
 * Chat's localStorage key of the theme before the shared `hd_theme` cookie:
 * read while the visitor has no shared choice yet, so nobody loses the theme
 * they picked.
 */
export const LEGACY_THEME_KEY = "app:theme";

const FONT_KEY = "app:message-font";
export const FONT_MIN = 13;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 15;

export function storedFontSize(): number {
	let value = Number.NaN;
	try {
		value = Number(window.localStorage.getItem(FONT_KEY));
	} catch {
		// Storage off: the default size.
	}
	return Number.isInteger(value) && value >= FONT_MIN && value <= FONT_MAX ? value : FONT_DEFAULT;
}

function applyFontSize(px: number): void {
	if (px === FONT_DEFAULT) document.documentElement.style.removeProperty("--msg-font");
	else document.documentElement.style.setProperty("--msg-font", `${px / 16}rem`);
}

export function setFontSize(px: number): void {
	const clamped = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, px)));
	try {
		window.localStorage.setItem(FONT_KEY, String(clamped));
	} catch {
		// Storage off: the choice lasts until the tab closes.
	}
	applyFontSize(clamped);
}

/** Puts the stored text size on <html>; run once before rendering. */
export function applyStoredAppearance(): void {
	applyFontSize(storedFontSize());
}
