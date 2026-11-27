// Appearance (mockups/settings.html#appearance). The theme is the shared
// choice of every hoandat.com app (shared-theme.ts); the size of message
// text and the size of the whole interface stay on this device.

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

const SCALE_KEY = "app:ui-scale";
/** Interface size in percent: the root font size, which every rem length of the styles follows. */
export const SCALE_MIN = 90;
export const SCALE_MAX = 130;
export const SCALE_STEP = 5;
export const SCALE_DEFAULT = 110;

export function storedUiScale(): number {
	let value = Number.NaN;
	try {
		const stored = window.localStorage.getItem(SCALE_KEY);
		value = stored === null ? Number.NaN : Number(stored);
	} catch {
		// Storage off: the default size.
	}
	return Number.isInteger(value) && value >= SCALE_MIN && value <= SCALE_MAX ? value : SCALE_DEFAULT;
}

function applyUiScale(percent: number): void {
	document.documentElement.style.fontSize = `${percent}%`;
}

export function setUiScale(percent: number): void {
	const stepped = Math.round(percent / SCALE_STEP) * SCALE_STEP;
	const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped));
	try {
		window.localStorage.setItem(SCALE_KEY, String(clamped));
	} catch {
		// Storage off: the choice lasts until the tab closes.
	}
	applyUiScale(clamped);
}

/** Puts the stored text size and interface size on <html>; run once before rendering. */
export function applyStoredAppearance(): void {
	applyFontSize(storedFontSize());
	applyUiScale(storedUiScale());
}
