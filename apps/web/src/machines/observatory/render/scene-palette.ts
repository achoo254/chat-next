// The Live Map renderer's colours and reusable sprites. Colours are the web's
// tokens (tokens.css of the app shell, station-palette.css), read from CSS
// when the scene mounts; no colour value lives in the renderer. A glow is a
// soft white circle drawn once in code and tinted per use (no filters: the
// Canvas renderer has none).
import { Container, Sprite, Texture } from "pixi.js";
import type { PlaceId } from "./scene-table.ts";
import type { Tone } from "./prop-map.ts";

/** Colours as 0xRRGGBB. */
export type PaletteKey = Tone | "text" | "think" | PlaceId;
export type Palette = Readonly<Record<PaletteKey, number>>;

/** The CSS token of each colour. */
export const PALETTE_TOKENS: Readonly<Record<PaletteKey, string>> = {
	normal: "--c-primary",
	success: "--c-success",
	warn: "--c-warning",
	error: "--c-error",
	muted: "--c-text-muted",
	text: "--c-text",
	think: "--c-station-core",
	core: "--c-station-core",
	orchestrator: "--c-station-orchestrator",
	files: "--c-station-files",
	memory: "--c-station-memory",
	skills: "--c-station-skills",
	mcp: "--c-station-mcp",
	external: "--c-station-external",
	sandbox: "--c-station-sandbox",
	testing: "--c-station-testing",
	git: "--c-station-git",
	monitoring: "--c-station-memory",
	security: "--c-warning",
	"user-desk": "--c-text",
};

/**
 * The palette from the tokens as `host` sees them: each is resolved by the
 * browser and read back as one pixel, so any CSS colour syntax works.
 * Unreadable (no 2D canvas) is white, which a tint leaves as drawn.
 */
export function readPalette(host: HTMLElement): Palette {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const probe = document.createElement("span");
	host.appendChild(probe);
	const read = (token: string): number => {
		probe.style.color = `var(${token})`;
		const css = getComputedStyle(probe).color;
		if (ctx === null || css === "") return 0xffffff;
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r = 255, g = 255, b = 255] = ctx.getImageData(0, 0, 1, 1).data;
		return (r << 16) | (g << 8) | b;
	};
	const palette = Object.fromEntries(Object.entries(PALETTE_TOKENS).map(([key, token]) => [key, read(token)])) as Record<PaletteKey, number>;
	probe.remove();
	return palette;
}

/** A soft white circle (alpha falling off to the edge): drawn once, tinted per use. */
export function makeGlowTexture(size = 256): Texture {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (ctx !== null) {
		const r = size / 2;
		const g = ctx.createRadialGradient(r, r, 0, r, r, r);
		g.addColorStop(0, "rgba(255,255,255,1)");
		g.addColorStop(0.45, "rgba(255,255,255,0.55)");
		g.addColorStop(1, "rgba(255,255,255,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	}
	return Texture.from(canvas);
}

/** Sprites reused frame after frame; the ones not taken in a frame are hidden. */
export class SpritePool {
	private readonly items: Sprite[] = [];
	private used = 0;
	constructor(private readonly parent: Container) {}
	begin(): void {
		this.used = 0;
	}
	take(texture: Texture): Sprite {
		let s = this.items[this.used];
		if (s === undefined) {
			s = new Sprite(texture);
			this.items.push(s);
			this.parent.addChild(s);
		} else if (s.texture !== texture) s.texture = texture;
		this.used += 1;
		s.anchor.set(0.5);
		s.visible = true;
		s.alpha = 1;
		s.rotation = 0;
		s.tint = 0xffffff;
		return s;
	}
	end(): void {
		for (let i = this.used; i < this.items.length; i++) {
			const s = this.items[i];
			if (s !== undefined) s.visible = false;
		}
	}
}
