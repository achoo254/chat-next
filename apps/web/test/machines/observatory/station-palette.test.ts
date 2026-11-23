// The Live Map's one station palette (station-palette.css): a colour for every
// station in light and dark, the two dark blocks alike, every colour readable
// on the replay bar's track (3:1, the contrast for graphics), the ten hues
// apart from each other and from the bottleneck, failure and no-station
// colours; the replay bar and the drawer take it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STATION_CODES } from "../../../src/machines/observatory/station-catalog.ts";

// Read from disk: the test runner hands CSS imports over empty, even `?raw`.
const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const paletteCss = source("../../../src/machines/observatory/station-palette.css");
const drawerCss = source("../../../src/machines/observatory/live-map-drawer.css");
const tokensCss = readFileSync(createRequire(import.meta.url).resolve("@achoo254/app-shell/tokens.css"), "utf8");

type Theme = "light" | "dark";

/** The declarations of the first block opened by `selector` (blocks hold no nested braces). */
function block(css: string, selector: string): Map<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`no block ${selector}`);
	const open = css.indexOf("{", start);
	const body = css.slice(open + 1, css.indexOf("}", open));
	const out = new Map<string, string>();
	for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
		const [, name, value] = m;
		if (name !== undefined && value !== undefined) out.set(name, value.toLowerCase());
	}
	return out;
}

const palette: Record<Theme | "forcedDark", Map<string, string>> = {
	light: block(paletteCss, ":root"),
	dark: block(paletteCss, ':root:not([data-theme="light"])'),
	forcedDark: block(paletteCss, ':root[data-theme="dark"]'),
};
const tokens: Record<Theme, Map<string, string>> = {
	light: block(tokensCss, ":root"),
	dark: block(tokensCss, ':root[data-theme="dark"]'),
};

const tokenOf = (code: string): string => `--c-station-${code.toLowerCase()}`;

function hex(map: Map<string, string>, name: string): string {
	const value = map.get(name);
	if (value === undefined) throw new Error(`no ${name}`);
	return value;
}

/** The linear red, green and blue of a #rrggbb colour. */
function linearRgb(h: string): readonly [number, number, number] {
	const channel = (at: number): number => {
		const c = parseInt(h.slice(at, at + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return [channel(1), channel(3), channel(5)];
}

function luminance(h: string): number {
	const [r, g, b] = linearRgb(h);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [la, lb] = [luminance(a), luminance(b)];
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIELAB (D65) of a #rrggbb colour. */
function lab(h: string): readonly [number, number, number] {
	const [r, g, b] = linearRgb(h);
	const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
	const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
	const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 distance between two colours. */
function distance(a: string, b: string): number {
	const [p, q] = [lab(a), lab(b)];
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

describe("the Live Map's station palette", () => {
	it("has a colour for every station in light and dark, and a rule giving it to an element tagged with the station", () => {
		for (const code of STATION_CODES) {
			for (const theme of ["light", "dark", "forcedDark"] as const) expect(palette[theme].has(tokenOf(code)), `${code} ${theme}`).toBe(true);
			expect(paletteCss).toContain(`[data-station="${code}"] { --station: var(${tokenOf(code)}); }`);
		}
		expect(palette.light.size).toBe(STATION_CODES.length);
	});

	it("keeps the dark block of the OS preference and the forced one alike", () => {
		expect([...palette.dark]).toEqual([...palette.forcedDark]);
	});

	for (const theme of ["light", "dark"] as const) {
		it(`reads on the bar's track and keeps the stations apart in ${theme}`, () => {
			const track = hex(tokens[theme], "--c-bar-track");
			const reserved = ["--c-warning", "--c-error", "--c-viz-grey"].map((name) => hex(tokens[theme], name));
			const colours = STATION_CODES.map((code) => hex(palette[theme], tokenOf(code)));
			for (const colour of colours) {
				expect(contrast(colour, track), colour).toBeGreaterThanOrEqual(3);
				for (const other of reserved) expect(distance(colour, other), `${colour} vs ${other}`).toBeGreaterThanOrEqual(20);
			}
			colours.forEach((a, i) => {
				for (const b of colours.slice(i + 1)) expect(distance(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(12);
			});
		});
	}

	it("colours the replay bar's marks and the drawer's edge from it", () => {
		expect(drawerCss).toMatch(/\.lmd-mark \{[^}]*background: var\(--station,/);
		expect(drawerCss).toMatch(/\.lmd-panel\[data-station\] \{[^}]*var\(--station,/);
		expect(drawerCss).not.toMatch(/\.lmd-mark\[data-station=/);
	});
});
