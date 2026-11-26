// The Live Map's ink: the design's colours and the helper that tints a hex colour.
/** The design's colours: one dark look on purpose (the inside of a running machine). */
export const INK = {
	board: "#0c121a",
	box: "#121923",
	boxGlow: "#141b25",
	edge: "#2b3644",
	fg: "#dfe6ee",
	muted: "#8593a3",
	ok: "#3dd68c",
	warn: "#ffc53d",
	err: "#ff6369",
	think: "#baa7ff",
	copper: "#7a5a3c",
} as const;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function hexRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.replace("#", ""), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
	const [r, g, b] = hexRgb(hex);
	return `rgba(${r},${g},${b},${clamp01(a)})`;
}
