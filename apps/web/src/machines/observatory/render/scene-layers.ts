// The Live Map's PixiJS layers, in scene pixels (2400x1440) under one root
// the caller places with the fit and the camera: the plate, the energy roads
// and pipeline (data-layers.ts), the districts as AI-drawn sprites fitted to
// their rect (bottom centred) with a glow and a gentle pulse while they work,
// the AI core's tower with its halo turning at its base (sparks while the
// model thinks), the portal swirl of the internet district, the context
// reservoir filled to the context's percent, the subagent drones flying the
// roads to the district of their call, the holographic board above the
// district in view, and the packets of the current frame. A district whose
// frame is a lit crop (`lit-<id>`: the district is painted into the plate) is
// that crop laid over its rect, faded in while the district works. A frame name an
// atlas does not hold draws nothing; the data layers (roads, packets, sparks,
// pipeline, wave) are drawn in code and always show.
import { Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { ease, type MoveFrame } from "./animation-director.ts";
import { drawPipeline, drawRoads, drawSelection, drawTether, drawWave } from "./data-layers.ts";
import { dronePath, holoPanelRect, hoverPoint, orbitPoint, pathLength, pathPoint, placeCentre, roadOf, type SceneLook } from "./prop-map.ts";
import { SpritePool, type Palette } from "./scene-palette.ts";
import { PLACE_IDS, type PlaceId, type Point, type Rect, type SceneTable } from "./scene-table.ts";

export { makeGlowTexture, readPalette, type Palette } from "./scene-palette.ts";

export interface LayerTextures {
	readonly plate: Texture;
	readonly glow: Texture;
	/** Atlas frames by name (none until the art is drawn). */
	readonly sprites: ReadonlyMap<string, Texture>;
}

/** Where the root sits in the frame: CSS px per scene px and the offset. */
export interface RootPlacement {
	readonly scale: number;
	readonly x: number;
	readonly y: number;
}

export interface LayerFrame {
	/** Animation time (ms). */
	readonly t: number;
	/** The machine's clock now (ms). */
	readonly wall: number;
	readonly moves: readonly MoveFrame[];
	/** The model thinks on the scene (sparks). */
	readonly thinking: boolean;
	/** Continuous motion (flow, spin, sparks, flight) may run: false under reduced motion. */
	readonly motion: boolean;
}

/** Drone speed along the roads, scene px per ms. */
const DRONE_SPEED = 0.9;
const DRONE_MIN_MS = 600;
/** The halo lies on the platform: an isometric ellipse about 0.37 as tall as wide. */
const HALO_SQUASH = 0.37;
/** A lit crop fades in or out over about this long. */
const LIT_FADE_MS = 300;
/** A lit district used earlier in the session keeps this faint light. */
const LIT_USED = 0.15;
/** The internet district's portal arch, as a share of its rect. */
const PORTAL_AT: readonly [number, number] = [0.36, 0.32];

interface Flight {
	target: PlaceId;
	path: Point[];
	start: number;
	duration: number;
	slot: number;
	pos: Point;
}

interface Spark {
	angle: number;
	start: number;
}

/** A lit crop of the plate (`lit-<id>`): laid exactly over its rect and shown only while the district works. */
export const isLitFrame = (name: string): boolean => name.startsWith("lit-");

/** Sizes a sprite to fit `r` whole, standing on its bottom edge, centred; a lit crop covers `r` exactly. */
function fitInto(s: Sprite, r: Rect, lit: boolean): void {
	if (lit) {
		s.anchor.set(0, 0);
		s.position.set(r.x, r.y);
		s.width = r.w;
		s.height = r.h;
		return;
	}
	const tw = s.texture.width || 1;
	const th = s.texture.height || 1;
	const k = Math.min(r.w / tw, r.h / th);
	s.anchor.set(0.5, 1);
	s.scale.set(k);
	s.position.set(r.x + r.w / 2, r.y + r.h);
}

export class SceneLayers {
	readonly root = new Container();
	private readonly scene: SceneTable;
	private readonly textures: LayerTextures;
	private readonly palette: Palette;
	private readonly under = new Graphics();
	private readonly glows: SpritePool;
	private readonly districts = new Map<PlaceId, Sprite>();
	private readonly haloBox = new Container();
	private readonly halo: Sprite | null;
	private readonly swirl: Sprite | null;
	private readonly fill: Sprite | null;
	private fillTexture: Texture | null = null;
	private fillPercent = -1;
	private readonly holo: Sprite | null;
	private readonly over = new Graphics();
	private readonly pieces: SpritePool;
	private look: SceneLook | null = null;
	private selected: PlaceId | null = null;
	private contentZone: PlaceId | null = null;
	private readonly flights = new Map<string, Flight>();
	private sparks: Spark[] = [];
	/** A lit crop is still fading this frame. */
	private fading = false;
	/** Each lit crop's alpha now (it eases toward its target). */
	private readonly lit = new Map<PlaceId, number>();
	private lastT: number | null = null;
	private wavePhase = 0;

	constructor(scene: SceneTable, textures: LayerTextures, palette: Palette) {
		this.scene = scene;
		this.textures = textures;
		this.palette = palette;
		const plate = new Sprite(textures.plate);
		plate.width = scene.space.width;
		plate.height = scene.space.height;
		const glowLayer = new Container();
		const districtLayer = new Container();
		const pieceLayer = new Container();
		this.root.addChild(plate, this.under, glowLayer, districtLayer, this.haloBox, pieceLayer, this.over);
		this.glows = new SpritePool(glowLayer);
		this.pieces = new SpritePool(pieceLayer);
		for (const id of PLACE_IDS) {
			const place = scene.places[id];
			// The drones are drawn where they fly, not in a rect.
			if (id === "orchestrator") continue;
			const texture = this.frame(place.sprite);
			if (texture === null) continue;
			const s = new Sprite(texture);
			fitInto(s, place.rect, isLitFrame(place.sprite));
			districtLayer.addChild(s);
			this.districts.set(id, s);
		}
		// The halo lies flat around the tower's base: drawn in a container squashed to the isometric ground.
		this.haloBox.position.set(scene.core.centre[0], scene.core.centre[1]);
		this.haloBox.scale.set(1, HALO_SQUASH);
		const halo = this.frame("core-halo");
		this.halo = halo === null ? null : new Sprite(halo);
		if (this.halo !== null) {
			this.halo.anchor.set(0.5);
			const k = (scene.core.radius * 2) / (this.halo.texture.width || 1);
			this.halo.scale.set(k);
			this.haloBox.addChild(this.halo);
		}
		// The tower stands in front of its halo's back half: draw it above the halo.
		const tower = this.districts.get("core");
		if (tower !== undefined) {
			districtLayer.removeChild(tower);
			this.root.addChildAt(tower, this.root.getChildIndex(this.haloBox) + 1);
		}
		const swirl = this.frame("portal-swirl");
		this.swirl = swirl === null ? null : new Sprite(swirl);
		if (this.swirl !== null) {
			const r = scene.places.external.rect;
			const size = Math.min(r.w, r.h) * 0.25;
			this.swirl.anchor.set(0.5);
			this.swirl.scale.set(size / (this.swirl.texture.width || 1));
			this.swirl.position.set(r.x + r.w * PORTAL_AT[0], r.y + r.h * PORTAL_AT[1]);
			districtLayer.addChild(this.swirl);
		}
		const fill = this.frame("context-fill");
		this.fill = fill === null ? null : new Sprite(fill);
		if (this.fill !== null) districtLayer.addChild(this.fill);
		const holo = this.frame("holo-panel");
		this.holo = holo === null ? null : new Sprite(holo);
		if (this.holo !== null) {
			this.holo.visible = false;
			pieceLayer.addChild(this.holo);
		}
	}

	private frame(name: string): Texture | null {
		return this.textures.sprites.get(name) ?? null;
	}

	/** Places the root in the frame (fit and camera together). */
	layout(p: RootPlacement): void {
		this.root.scale.set(p.scale);
		this.root.position.set(p.x, p.y);
	}

	setLook(look: SceneLook): void {
		this.look = look;
		this.updateFill(look.contextPercent);
	}

	/** The selected place (outlined) and the place whose holographic board shows. */
	setFocus(selected: PlaceId | null, contentZone: PlaceId | null): void {
		this.selected = selected;
		this.contentZone = contentZone;
	}

	/** Where each running subagent's drone is (scene px). */
	dronePositions(): ReadonlyMap<string, Point> {
		return new Map([...this.flights].map(([id, f]) => [id, f.pos]));
	}

	/** Shows the context reservoir's fill up to `percent`: the fill frame cut from its bottom. */
	private updateFill(percent: number | null): void {
		const sprite = this.fill;
		if (sprite === null) return;
		const p = percent === null ? 0 : Math.round(Math.min(100, Math.max(0, percent)));
		if (p === this.fillPercent) return;
		this.fillPercent = p;
		const base = this.frame("context-fill");
		if (base === null) return;
		this.fillTexture?.destroy(false);
		this.fillTexture = null;
		if (p === 0) {
			sprite.visible = false;
			return;
		}
		const f = base.frame;
		const h = Math.max(1, f.height * (p / 100));
		this.fillTexture = new Texture({ source: base.source, frame: new Rectangle(f.x, f.y + f.height - h, f.width, h) });
		sprite.texture = this.fillTexture;
		sprite.visible = true;
		// The full fill covers the reservoir's rect; only its lower part is shown, standing on the rect's bottom.
		const r = this.scene.places.monitoring.rect;
		sprite.anchor.set(0, 1);
		sprite.scale.set(r.w / (f.width || 1), r.h / (f.height || 1));
		sprite.position.set(r.x, r.y + r.h);
		sprite.tint = p > 80 ? this.palette.warn : 0xffffff;
	}

	/** Draws one frame; returns whether a drone still flies or a district still fades (the frame after is needed). */
	drawFrame(f: LayerFrame): boolean {
		const look = this.look;
		const dt = this.lastT === null ? 0 : Math.max(0, Math.min(64, f.t - this.lastT));
		this.lastT = f.t;
		this.glows.begin();
		this.pieces.begin();
		const under = this.under.clear();
		const over = this.over.clear();
		let flying = false;
		this.fading = false;
		if (look !== null) {
			flying = this.flyDrones(look, f);
			drawRoads(under, look.roads, this.palette, { t: f.t, wall: f.wall, drones: this.dronePositions(), busy: look.mode !== "idle", flow: f.motion });
			drawPipeline(under, this.scene, look.pipeline, this.palette, f.t, f.motion);
			if (f.motion && look.mode === "think") this.wavePhase += dt * ((look.tokensPerSecond ?? 0) / 130) * 0.012;
			drawWave(under, this.scene.wave, look.mode === "think" ? (look.tokensPerSecond ?? 0) : 0, this.wavePhase, this.palette);
			this.drawDistricts(look, f, dt);
			this.drawCore(look, f, dt);
			this.drawDrones(look, f, over);
		}
		if (this.selected !== null) drawSelection(over, this.selectionBox(this.selected), this.palette);
		if (this.holo !== null) {
			const zone = this.contentZone;
			this.holo.visible = zone !== null;
			if (zone !== null) {
				const r = holoPanelRect(this.scene, zone);
				this.holo.anchor.set(0, 0);
				this.holo.position.set(r.x, r.y);
				this.holo.width = r.w;
				this.holo.height = r.h;
				this.holo.alpha = 1;
				// The board is faint on the dark plate: a tinted edge makes it read.
				over.roundRect(r.x + 6, r.y + 6, r.w - 12, r.h - 12, 14).stroke({ color: this.palette[zone], width: 3, alpha: 0.85 });
			}
		}
		for (const m of f.moves) this.drawMove(m);
		this.glows.end();
		this.pieces.end();
		return flying || this.fading;
	}

	private selectionBox(place: PlaceId): Rect {
		if (place !== "orchestrator") return this.scene.places[place].rect;
		const [cx, cy] = this.scene.core.centre;
		const [rx, ry] = this.scene.core.orbit;
		return { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
	}

	private drawDistricts(look: SceneLook, f: LayerFrame, dt: number): void {
		for (const id of PLACE_IDS) {
			const p = look.places[id];
			const focused = id === this.selected || id === this.contentZone;
			const presence = focused ? 1 : p.presence;
			const sprite = this.districts.get(id);
			// The reservoir is faint on the dark plate: never below 0.85 and a soft light behind it.
			const lit = isLitFrame(this.scene.places[id].sprite);
			// A lit crop (the district painted powered on) fades in while it works; a placed part shows by presence.
			if (sprite !== undefined && id !== "core") {
				if (lit) sprite.alpha = this.fadeLit(id, p.active || p.involved ? 1 : focused ? 0.35 : p.used ? LIT_USED : 0, f, dt);
				else sprite.alpha = id === "monitoring" ? Math.max(0.85, presence) : presence;
			}
			if (id === "monitoring") this.reservoirGlow(look);
			if (!p.active && p.bottleneck === "none") continue;
			// A district at work lights up: a glow under it, breathing while motion runs.
			const r = this.scene.places[id].rect;
			const g = this.glows.take(this.textures.glow);
			const [cx, cy] = id === "core" ? this.scene.core.centre : [r.x + r.w / 2, r.y + r.h * 0.6];
			g.position.set(cx, cy);
			const size = Math.max(r.w, r.h * 1.4) * 1.05;
			g.width = size;
			g.height = size * 0.6;
			g.tint = p.bottleneck === "alert" ? this.palette.error : p.bottleneck === "warn" && !p.active ? this.palette.warn : this.palette[id];
			g.alpha = p.active ? (f.motion ? 0.42 + 0.18 * Math.sin(f.t / 300) : 0.5) : 0.4;
			// The district's devices at work: a gentle scan of light across it.
			if (p.active && f.motion && sprite !== undefined) {
				const scan = this.glows.take(this.textures.glow);
				const k = (f.t / 1600) % 1;
				scan.position.set(r.x + r.w / 2, r.y + r.h * (0.25 + 0.6 * k));
				scan.width = r.w * 0.9;
				scan.height = r.h * 0.12;
				scan.tint = this.palette[id];
				scan.alpha = 0.35 * Math.sin(Math.PI * k);
			}
		}
	}

	/** Eases a lit crop's alpha toward `target` (jumps without motion); notes when it is still fading. */
	private fadeLit(id: PlaceId, target: number, f: LayerFrame, dt: number): number {
		const now = this.lit.get(id) ?? 0;
		const next = !f.motion ? target : now + Math.sign(target - now) * Math.min(Math.abs(target - now), dt / LIT_FADE_MS);
		this.lit.set(id, next);
		if (Math.abs(target - next) > 0.01 && f.motion) this.fading = true;
		return next;
	}

	private reservoirGlow(look: SceneLook): void {
		const r = this.scene.places.monitoring.rect;
		const g = this.glows.take(this.textures.glow);
		g.position.set(r.x + r.w / 2, r.y + r.h * 0.55);
		g.width = r.w * 1.6;
		g.height = r.h * 1.1;
		g.tint = (look.contextPercent ?? 0) > 80 ? this.palette.warn : this.palette.monitoring;
		g.alpha = 0.3;
	}

	private drawCore(look: SceneLook, f: LayerFrame, dt: number): void {
		const tower = this.districts.get("core");
		const thinking = f.thinking;
		const exec = look.mode === "exec";
		const waiting = look.mode === "wait";
		// The tower breathes at rest, glows while it thinks, stays calm while tools carry the work.
		const breathe = f.motion ? Math.sin(f.t / (thinking ? 500 : 1800)) : 0;
		if (tower !== undefined) {
			if (isLitFrame(this.scene.places.core.sprite)) tower.alpha = this.fadeLit("core", thinking ? 0.85 + 0.15 * breathe : waiting ? 0.6 : look.places.core.used || exec ? LIT_USED : 0.08 + 0.06 * breathe, f, dt);
			else tower.alpha = thinking ? 1 : exec ? 0.85 : 0.9 + 0.08 * breathe;
		}
		const g = this.glows.take(this.textures.glow);
		const [cx, cy] = this.scene.core.centre;
		g.position.set(cx, cy);
		g.width = this.scene.core.radius * 3.2;
		g.height = this.scene.core.radius * 1.5;
		g.tint = waiting ? this.palette.warn : this.palette.think;
		g.alpha = thinking ? 0.55 + 0.15 * breathe : exec ? 0.18 : 0.22 + 0.06 * breathe;
		if (this.halo !== null) {
			if (f.motion) this.halo.rotation = f.t / (thinking ? 2200 : exec ? 9000 : 14000);
			this.halo.alpha = thinking ? 0.75 : 0.35;
			this.halo.tint = waiting ? this.palette.warn : 0xffffff;
		}
		const portalBusy = look.places.external.active;
		if (this.swirl !== null && f.motion) this.swirl.rotation = f.t / (portalBusy ? 450 : 4000);
		// Sparks run out along the halo's radii while the model thinks, more with a faster output.
		if (thinking && f.motion) {
			const rate = 0.02 + (look.tokensPerSecond ?? 0) / 4000;
			const n = dt * rate;
			for (let k = 0; k < Math.floor(n) + (Math.random() < n % 1 ? 1 : 0); k++) this.sparks.push({ angle: Math.random() * Math.PI * 2, start: f.t });
		}
		const R = this.scene.core.radius;
		const kept: Spark[] = [];
		for (const s of this.sparks) {
			const u = (f.t - s.start) / 520;
			if (u >= 1 || u < 0) continue;
			kept.push(s);
			const r = R * (0.25 + 0.95 * u);
			const p = this.pieces.take(this.frame("packet") ?? this.textures.glow);
			p.position.set(cx + Math.cos(s.angle) * r, cy + Math.sin(s.angle) * r * 0.42);
			p.width = 26;
			p.height = 26;
			p.tint = this.palette.think;
			p.alpha = Math.sin(Math.PI * u);
		}
		this.sparks = thinking && f.motion ? kept.slice(-160) : [];
	}

	/** Moves each drone toward its district; returns whether one is in flight. */
	private flyDrones(look: SceneLook, f: LayerFrame): boolean {
		const turn = f.motion ? f.t / 2600 : 0;
		const alive = new Set(look.drones.map((d) => d.agentId));
		for (const id of this.flights.keys()) if (!alive.has(id)) this.flights.delete(id);
		let flying = false;
		for (const d of look.drones) {
			const home = orbitPoint(this.scene, d.slot, turn);
			let flight = this.flights.get(d.agentId);
			if (flight === undefined) {
				// A new drone leaves the tower's base.
				const path = dronePath(this.scene, this.scene.core.centre, "core", d.target, home);
				flight = { target: d.target, path, start: f.t, duration: this.flightMs(path, f.motion), slot: d.slot, pos: this.scene.core.centre };
				this.flights.set(d.agentId, flight);
			} else if (flight.target !== d.target) {
				const path = dronePath(this.scene, flight.pos, flight.target, d.target, home);
				Object.assign(flight, { target: d.target, path, start: f.t, duration: this.flightMs(path, f.motion) });
			}
			flight.slot = d.slot;
			const u = flight.duration === 0 ? 1 : (f.t - flight.start) / flight.duration;
			if (u < 1) {
				flying = true;
				flight.pos = pathPoint(flight.path, ease(u));
			} else if (d.target === "orchestrator" || d.target === "core") flight.pos = home;
			else {
				const [hx, hy] = hoverPoint(this.scene, d.target);
				flight.pos = [hx, hy + (f.motion ? Math.sin(f.t / 400 + d.slot) * 8 : 0)];
			}
		}
		return flying;
	}

	private flightMs(path: readonly Point[], motion: boolean): number {
		return motion ? Math.max(DRONE_MIN_MS, pathLength(path) / DRONE_SPEED) : 0;
	}

	private drawDrones(look: SceneLook, f: LayerFrame, g: Graphics): void {
		const texture = this.frame("drone");
		for (const d of look.drones) {
			const flight = this.flights.get(d.agentId);
			if (flight === undefined) continue;
			const [x, y] = flight.pos;
			const atWork = d.target !== "orchestrator" && d.target !== "core";
			const road = roadOf(this.scene, d.target);
			const to = atWork ? (road[road.length - 1] ?? placeCentre(this.scene, d.target)) : this.scene.core.centre;
			drawTether(g, flight.pos, to, this.palette.orchestrator, f.t, f.motion);
			const glow = this.glows.take(this.textures.glow);
			glow.position.set(x, y);
			glow.width = 110;
			glow.height = 110;
			glow.tint = this.palette.orchestrator;
			glow.alpha = 0.55;
			if (texture !== null) {
				const s = this.pieces.take(texture);
				s.position.set(x, y);
				s.scale.set(84 / (texture.width || 1));
			}
		}
	}

	private drawMove(m: MoveFrame): void {
		const { move } = m.active;
		const colour = move.tone === "normal" ? this.palette[move.place] : this.palette[move.tone];
		const fade = Math.sin(Math.PI * Math.min(1, m.t));
		if (move.kind === "packet-out" || move.kind === "packet-back") {
			const texture = this.frame("packet") ?? this.textures.glow;
			// The packet and a short trail behind it.
			for (let k = 5; k >= 0; k--) {
				const at = pathPoint(move.path, Math.max(0, ease(m.t) - k * 0.025));
				const p = this.pieces.take(texture);
				p.position.set(at[0], at[1]);
				const size = k === 0 ? 40 : 30 - k * 4;
				p.width = size;
				p.height = size;
				p.tint = colour;
				p.alpha = k === 0 ? 1 : 0.55 - k * 0.08;
			}
			return;
		}
		const g = this.glows.take(this.textures.glow);
		const [x, y] = m.at;
		const size = move.kind === "alarm" ? 300 + 300 * m.t : move.kind === "batch" ? 360 : 280;
		g.position.set(x, y);
		g.width = size;
		g.height = size * 0.7;
		g.tint = colour;
		g.alpha = 0.85 * (move.kind === "alarm" ? 1 - m.t : fade);
	}

	destroy(): void {
		this.fillTexture?.destroy(false);
		this.fillTexture = null;
	}
}
