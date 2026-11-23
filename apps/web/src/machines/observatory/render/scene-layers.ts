// The Live Map's PixiJS layers, in plate pixels (2560x1920) under one root
// scaled to the frame: the plate, the still look (glows tinted by tone with a
// fixed alpha, queued calls, parked drones), and the moving pieces of the
// current frame. No filters (the Canvas renderer has none): a glow is a soft
// white circle sprite tinted with `tint`. Pieces come from the sprite atlases
// the asset table lists when they hold the sprite's name
// (tools/observatory-art/prompts/sprites.json); until the art is drawn a piece
// is a plain shape, so the real sprites replace the shapes by name with no
// code change. Colours are the web's tokens, read from CSS when the scene
// mounts; no colour value lives here.
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { ease, type MoveFrame } from "./animation-director.ts";
import type { MotionKind, SceneLook, Tone } from "./prop-map.ts";
import { coreCentre } from "./prop-map.ts";
import type { SceneTable } from "./scene-table.ts";

/** Colours of the tones, as 0xRRGGBB. */
export type Palette = Readonly<Record<Tone | "piece", number>>;

/** The CSS token of each tone (tokens.css of the web app). */
export const TONE_TOKENS: Readonly<Record<keyof Palette, string>> = {
	normal: "--c-primary",
	success: "--c-success",
	warn: "--c-warning",
	error: "--c-error",
	muted: "--c-text-muted",
	piece: "--c-surface",
};

/**
 * The palette from the tokens as `host` sees them: each is resolved by the
 * browser and read back as one pixel, so any CSS colour syntax works.
 * Unreadable (no 2D canvas) is white, which the tint leaves as drawn.
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
	const palette = Object.fromEntries(Object.entries(TONE_TOKENS).map(([tone, token]) => [tone, read(token)])) as Record<keyof Palette, number>;
	probe.remove();
	return palette;
}

/** A soft white circle (alpha falling off to the edge) for glows: drawn once, tinted per use. */
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

/** The sprite (sprites.json name) that draws a move's piece once the atlases hold it. */
const PIECE_SPRITES: Partial<Record<MotionKind, string>> = {
	envelope: "envelope",
	"drone-out": "drone-fly",
	"drone-return": "drone-carry",
	"drone-launch": "drone-fly",
	"drone-land": "drone-carry",
	scroll: "scroll",
	"document-orbit": "document",
	"document-in": "document",
	conveyor: "box",
	rocket: "rocket",
	branch: "branch-new",
	jar: "jar-glow",
	"cloud-flicker": "cloud-flicker",
	shield: "shield",
};

/** Moves drawn as a glow in place (size in plate pixels). */
const GLOW_SIZES: Partial<Record<MotionKind, number>> = {
	jar: 90,
	wire: 110,
	"wire-down": 110,
	"cloud-flicker": 380,
	screen: 220,
	gate: 320,
	shield: 220,
	board: 240,
	"monitor-dot": 120,
	"core-pulse": 300,
	"core-shrink": 520,
	"core-red": 560,
	"desk-lamp": 260,
	"alert-ring": 480,
	batch: 340,
	bubbles: 160,
};

/** Sprites reused frame after frame; the ones not taken in a frame are hidden. */
class SpritePool {
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
			s.anchor.set(0.5);
			this.items.push(s);
			this.parent.addChild(s);
		} else if (s.texture !== texture) s.texture = texture;
		this.used += 1;
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

export interface LayerTextures {
	readonly plate: Texture;
	readonly glow: Texture;
	/** Atlas sprites by name (empty until the art is drawn). */
	readonly sprites: ReadonlyMap<string, Texture>;
}

export class SceneLayers {
	readonly root = new Container();
	private readonly still = new Container();
	private readonly stillShapes = new Graphics();
	private readonly moving = new Container();
	private readonly shapes = new Graphics();
	private readonly stillGlows: SpritePool;
	private readonly pieces: SpritePool;
	private readonly scene: SceneTable;
	private readonly textures: LayerTextures;
	private readonly palette: Palette;

	constructor(scene: SceneTable, textures: LayerTextures, palette: Palette) {
		this.scene = scene;
		this.textures = textures;
		this.palette = palette;
		const plate = new Sprite(textures.plate);
		plate.width = scene.space.width;
		plate.height = scene.space.height;
		this.root.addChild(plate, this.still, this.moving);
		this.stillGlows = new SpritePool(this.still);
		this.still.addChild(this.stillShapes);
		this.pieces = new SpritePool(this.moving);
		this.moving.addChild(this.shapes);
	}

	/** Scales the root so the plate fits the frame (CSS pixels). */
	layout(fit: { scale: number; offsetX: number; offsetY: number }): void {
		this.root.scale.set(fit.scale);
		this.root.position.set(fit.offsetX, fit.offsetY);
	}

	/** Draws the still look. */
	setLook(look: SceneLook): void {
		this.stillGlows.begin();
		for (const glow of look.glows) {
			const s = this.stillGlows.take(this.textures.glow);
			s.position.set(glow.at[0], glow.at[1]);
			s.width = glow.size;
			s.height = glow.size;
			s.tint = this.palette[glow.tone];
			s.alpha = glow.alpha;
		}
		this.stillGlows.end();
		const g = this.stillShapes;
		g.clear();
		for (const [x, y] of look.queued) g.circle(x, y, 22).fill({ color: this.palette.normal, alpha: 0.9 }).stroke({ color: this.palette.piece, width: 4 });
		for (const [x, y] of look.drones) this.droneShape(g, x, y, this.palette.normal, 1);
		// Glows added since go under the shapes: keep the shapes last.
		this.still.addChild(this.stillShapes);
	}

	/** Draws the moving pieces of one frame; `spin` turns of the core's ring (null: still). */
	drawFrame(frames: readonly MoveFrame[], spinTurns: number | null): void {
		this.pieces.begin();
		const g = this.shapes;
		g.clear();
		if (spinTurns !== null) {
			const [cx, cy] = coreCentre(this.scene);
			const angle = spinTurns * Math.PI * 2;
			for (let i = 0; i < 3; i++) {
				const a = angle + (i * Math.PI * 2) / 3;
				g.circle(cx + Math.cos(a) * 240, cy + Math.sin(a) * 90, 14).fill({ color: this.palette.normal, alpha: 0.9 });
			}
		}
		for (const f of frames) this.drawMove(g, f);
		this.pieces.end();
	}

	private drawMove(g: Graphics, f: MoveFrame): void {
		const { move } = f.active;
		const color = this.palette[move.tone];
		const fade = Math.sin(Math.PI * Math.min(1, f.t));
		const [x, y] = f.at;
		const glowSize = GLOW_SIZES[move.kind];
		if (move.kind === "beam") {
			const from = move.path[0] ?? f.at;
			g.moveTo(from[0], from[1]).lineTo(x, y).stroke({ color, width: 12, alpha: 0.85 * fade });
			g.circle(x, y, 18).fill({ color, alpha: fade });
			return;
		}
		if (glowSize !== undefined) {
			const flashes = Math.max(1, move.flashes);
			const pulse = Math.abs(Math.sin(Math.PI * f.t * flashes));
			const s = this.pieces.take(this.textures.glow);
			s.position.set(x, y);
			const grow = move.kind === "core-shrink" ? 1 - 0.4 * ease(f.t) : move.kind === "alert-ring" ? 0.6 + 0.6 * f.t : 1;
			s.width = glowSize * grow;
			s.height = glowSize * grow;
			s.tint = color;
			s.alpha = 0.85 * pulse;
			const sprite = this.sprite(move.kind);
			if (sprite !== null) {
				const p = this.pieces.take(sprite);
				p.position.set(x, y);
				p.alpha = pulse;
			} else if (move.kind === "bubbles") {
				for (let i = 0; i < 3; i++) g.circle(x - 40 + i * 40, y - 120 * ((f.t + i / 3) % 1), 14).fill({ color, alpha: fade });
			}
			return;
		}
		const sprite = this.sprite(move.kind);
		if (sprite !== null) {
			const p = this.pieces.take(sprite);
			p.position.set(x, y);
			p.alpha = Math.min(1, fade * 2);
			if (move.tone === "error") p.tint = color;
			return;
		}
		const alpha = Math.min(1, fade * 2);
		const fill = { color, alpha };
		const edge = { color: this.palette.piece, width: 4, alpha };
		switch (move.kind) {
			case "envelope":
				g.rect(x - 36, y - 24, 72, 48).fill(fill).stroke(edge);
				g.moveTo(x - 36, y - 24).lineTo(x, y + 4).lineTo(x + 36, y - 24).stroke(edge);
				return;
			case "document-orbit": {
				const a = f.t * Math.PI * 2;
				this.paper(g, x + Math.cos(a) * 140, y + Math.sin(a) * 70, fill, edge);
				return;
			}
			case "document-in":
				this.paper(g, x, y, fill, edge);
				return;
			case "scroll":
				g.roundRect(x - 48, y - 20, 96, 40, 16).fill(fill).stroke(edge);
				return;
			case "conveyor":
			case "drone-return":
			case "drone-land":
				if (move.kind !== "conveyor") this.droneShape(g, x, y - 40, color, alpha);
				g.rect(x - 28, y - 28, 56, 56).fill(fill).stroke(edge);
				return;
			case "drone-out":
			case "drone-launch":
				this.droneShape(g, x, y, color, alpha);
				return;
			case "rocket":
				g.poly([x, y - 80, x + 34, y + 30, x - 34, y + 30]).fill(fill).stroke(edge);
				g.circle(x, y + 50, 20 * fade).fill({ color: this.palette.warn, alpha });
				return;
			case "verdict":
				if (move.tone === "success") g.moveTo(x - 50, y).lineTo(x - 12, y + 40).lineTo(x + 56, y - 46).stroke({ color, width: 22, alpha });
				else g.moveTo(x - 46, y - 46).lineTo(x + 46, y + 46).moveTo(x + 46, y - 46).lineTo(x - 46, y + 46).stroke({ color, width: 22, alpha });
				return;
			case "branch": {
				const len = 180 * ease(f.t);
				g.moveTo(x, y).lineTo(x + len, y - len * 0.6).stroke({ color, width: 14, alpha });
				g.circle(x + len, y - len * 0.6, 16).fill(fill);
				return;
			}
			default:
				g.circle(x, y, 30).fill(fill);
		}
	}

	private paper(g: Graphics, x: number, y: number, fill: { color: number; alpha: number }, edge: { color: number; width: number; alpha: number }): void {
		g.rect(x - 26, y - 34, 52, 68).fill(fill).stroke(edge);
	}

	private droneShape(g: Graphics, x: number, y: number, color: number, alpha: number): void {
		const sprite = this.textures.sprites.get("drone-fly");
		if (sprite !== undefined) {
			const p = this.pieces.take(sprite);
			p.position.set(x, y);
			p.alpha = alpha;
			return;
		}
		g.circle(x, y, 38).fill({ color, alpha }).stroke({ color: this.palette.piece, width: 5, alpha });
		g.circle(x, y, 14).fill({ color: this.palette.piece, alpha });
		for (const dx of [-52, 52]) g.moveTo(x + dx - 20, y - 40).lineTo(x + dx + 20, y - 40).stroke({ color: this.palette.piece, width: 6, alpha });
	}

	private sprite(kind: MotionKind): Texture | null {
		const name = PIECE_SPRITES[kind];
		return name === undefined ? null : (this.textures.sprites.get(name) ?? null);
	}
}
