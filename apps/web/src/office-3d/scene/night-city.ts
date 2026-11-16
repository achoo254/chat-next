// The city at night behind the office windows (the concept's lit skyline),
// drawn in code on a canvas instead of a baked picture: a dusk sky, rows of
// tower silhouettes and their windows, some lit warm, a few cold. Seeded, so
// every visit sees the same skyline. The baked shell lays it over the window
// panes and fades it in with the night (baked-shell.ts).
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

// Small on purpose: a pane is some 60 CSS px wide on screen, so the drawing is
// a few towers with big windows that survive being shrunk.
const WIDTH = 128;
const HEIGHT = 64;

/** A small deterministic generator (mulberry32): the same skyline on every load. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function createNightCityTexture(scene: Scene): DynamicTexture {
	const texture = new DynamicTexture("night-city", { width: WIDTH, height: HEIGHT }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
	const ctx = texture.getContext();
	const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
	sky.addColorStop(0, "#1a2152");
	sky.addColorStop(0.6, "#3b3a78");
	sky.addColorStop(1, "#6b5594");
	ctx.fillStyle = sky;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);
	const random = seeded(254);
	// Far towers first (lighter, fewer windows), near ones over them.
	for (const row of [
		{ tone: "#2a2a58", minH: 0.6, maxH: 0.95, lit: 0.35 },
		{ tone: "#16163a", minH: 0.45, maxH: 0.8, lit: 0.55 },
	]) {
		let x = -4;
		while (x < WIDTH) {
			const w = 14 + random() * 14;
			const h = HEIGHT * (row.minH + random() * (row.maxH - row.minH));
			const top = Math.round(HEIGHT - h);
			ctx.fillStyle = row.tone;
			ctx.fillRect(Math.round(x), top, Math.round(w), HEIGHT - top);
			for (let wy = top + 3; wy < HEIGHT - 3; wy += 6) {
				for (let wx = x + 3; wx < x + w - 4; wx += 5) {
					const r = random();
					if (r > row.lit) continue;
					ctx.fillStyle = r < row.lit * 0.15 ? "#cfe0ff" : r < row.lit * 0.65 ? "#ffd98a" : "#f0aa50";
					ctx.fillRect(Math.round(wx), wy, 3, 3);
				}
			}
			x += w + 1 + random() * 3;
		}
	}
	// Not flipped: the panes' UVs run v down (glTF), like the canvas.
	texture.update(false);
	return texture;
}
