// The 3D office (plan decisions 9 and 10): boots Babylon on a canvas in the
// host element, builds the building from the layout (blocks first, baked
// models as the asset file lists them), and from then on only reads what the
// Office tab hands it (the store's state, everyone's placement, the floor,
// the hour) through `update`. Each frame: the floor-change glide, people
// walking and posing, room effects, the HTML labels and boards, render. The
// loop runs only while the page shows, the canvas is on screen and the app is
// in the foreground. Loaded on demand (its own chunk with Babylon).
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { SceneLoaderFlags } from "@babylonjs/core/Loading/sceneLoaderFlags";
import { Scene } from "@babylonjs/core/scene";
import { BOARD_ROOMS } from "../machines/office/office-boards.tsx";
import type { OfficeRendererProps } from "../machines/office/office-renderer.ts";
import type { OfficeSfx } from "./audio/office-sfx.ts";
import { createOfficeSfx, eventSoundFiles } from "./audio/office-sfx.ts";
import { createCharacterPool } from "./character/character-pool.ts";
import { createOfficePeople } from "./character/office-people.ts";
import { createRouter } from "./character/office-routes.ts";
import { createRenderEngine, type RendererPreference } from "./engine/create-render-engine.ts";
import { FrameStats } from "./engine/frame-stats.ts";
import { qualityLevelAt, startingQualityLevel } from "./engine/quality-levels.ts";
import { createQualityScaler } from "./engine/quality-scaler.ts";
import { configureSelfHostedDecoders } from "./engine/self-hosted-decoders.ts";
import { createOfficeOverlay, type BoardPin } from "./office-overlay.ts";
import { createRenderGate } from "./render-gate.ts";
import { createBlockKit } from "./scene/block-kit.ts";
import { CAMERA_DISTANCE, screenOffset } from "./scene/fit-office-camera.ts";
import { createFloorLibrary } from "./scene/floor-library.ts";
import { createFloorTransition } from "./scene/floor-transition.ts";
import { createOfficeCamera } from "./scene/office-camera.ts";
import { officeLighting } from "./scene/office-lighting.ts";
import { createOfficeLights } from "./scene/office-lights.ts";
import { createPostProcessing } from "./scene/post-processing.ts";
import { createPropLibrary } from "./scene/prop-library.ts";
import { createRoomFx } from "./scene/room-fx.ts";
import { assetUrl, loadSceneAssets, propSources } from "./scene/scene-assets.ts";
import { SCENE_LAYOUT } from "./scene/scene-layout.ts";
import { exposeTestApi, phoneDeskFocus } from "./world-support.ts";

export interface WorldOptions {
	readonly host: HTMLElement;
	readonly props: OfficeRendererProps;
	readonly preference: RendererPreference;
	/** A rung index pinned from the address, or null for the automatic scaler. */
	readonly pinnedQuality: number | null;
	readonly reducedMotion: boolean;
	readonly coarsePointer: boolean;
	readonly testApi: boolean;
	readonly signal: AbortSignal;
	readonly canvasLabel: string;
	/** The GPU context was lost (iOS under memory pressure): the view falls back to 2D. */
	readonly onLost: () => void;
}

export interface OfficeWorld {
	update(props: OfficeRendererProps, sound: boolean): void;
	bind(id: string, el: HTMLElement | null): void;
	dispose(): void;
}

export type BootResult = { readonly kind: "ready"; readonly world: OfficeWorld } | { readonly kind: "unsupported" };

/** Frames at the cheapest rung before the real one: depth of field or the shadow light before the first frame blanked the canvas (spike). */
const WARM_UP_FRAMES = 3;
/** Floors 2 and 3 are built this long after start, while idle. */
const PREPARE_AFTER_MS = 2_500;
/** Light flicker when the power goes out. */
const FLICKER_MS = 1_200;

export async function bootOfficeWorld(opts: WorldOptions): Promise<BootResult> {
	const host = opts.host;
	const layout = opts.props.layout;
	configureSelfHostedDecoders();
	// No Babylon loading screen: it injects inline styles, which style-src 'self' forbids.
	SceneLoaderFlags.ShowLoadingScreen = false;
	const render = await createRenderEngine(() => {
		const canvas = document.createElement("canvas");
		canvas.className = "of3d-canvas";
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", opts.canvasLabel);
		host.prepend(canvas);
		return canvas;
	}, opts.preference);
	if (render === null) return { kind: "unsupported" };
	const { engine, backend, canvas } = render;
	if (opts.signal.aborted) {
		engine.dispose();
		canvas.remove();
		return { kind: "unsupported" };
	}
	const fade = document.createElement("div");
	fade.className = "of3d-fade";
	host.append(fade);

	const scene = new Scene(engine);
	scene.skipPointerMovePicking = true;
	const instrumentation = new SceneInstrumentation(scene);
	const kit = createBlockKit(scene);
	const props = createPropLibrary(scene, kit);
	const floors = createFloorLibrary(scene, kit, props, SCENE_LAYOUT, opts.signal);
	const lights = createOfficeLights(scene, SCENE_LAYOUT.footprint);
	const camera = createOfficeCamera(scene, canvas, layout.camera, SCENE_LAYOUT.footprint, phoneDeskFocus(layout), opts.reducedMotion);
	const post = createPostProcessing(scene, camera.camera, "neutral");
	const pool = createCharacterPool(scene);
	let sfx: OfficeSfx = createOfficeSfx(new Map(), assetUrl);
	const transition = createFloorTransition(opts.props.floor, opts.reducedMotion);
	const people = createOfficePeople(layout, createRouter(layout, SCENE_LAYOUT.doorSeconds), pool, (event, floor) => {
		if (event === "approval" || floor === transition.frame(performance.now()).floor) sfx.play(event);
	});
	const fx = createRoomFx(scene, kit, SCENE_LAYOUT);
	const overlay = createOfficeOverlay();
	const boards: BoardPin[] = layout.floors.flatMap((f) => [
		...f.anchors.filter((a) => a.kind === "board" && a.room !== null && BOARD_ROOMS.includes(a.room)).map((a) => ({ id: a.id, floor: f.level, x: a.x, y: 2.15, z: a.z })),
		// The meeting room's "+N" over its table.
		...f.anchors.filter((a) => a.kind === "meeting").slice(0, 1).map((a) => ({ id: "overflow", floor: f.level, x: a.x, y: 1.6, z: a.z })),
	]);
	const startIndex = opts.pinnedQuality ?? startingQualityLevel(opts.coarsePointer);
	let fullRate = qualityLevelAt(0).fullRateCharacters;
	const scaler = createQualityScaler(engine, startIndex, opts.pinnedQuality !== null, (level) => {
		// SSAO2 fails to bind its noise texture on WebGPU here (blank frames): WebGL2 only.
		post.applyQuality(backend === "webgpu" ? { ...level, ssao: false } : level);
		lights.setShadowMapSize(level.shadowMapSize, () => people.meshes());
		fullRate = level.fullRateCharacters;
	});
	// Warm-up rung, applied directly (the scaler takes over after the first frames).
	post.applyQuality(qualityLevelAt(0));
	// The orthographic camera sits CAMERA_DISTANCE from its target: the tilt-shift keeps that plane sharp.
	post.focusAt(CAMERA_DISTANCE);

	let latest = opts.props;
	let soundOn = false;
	let frozen = latest.state.power === "out";
	let flickerUntil = 0;
	let light = officeLighting(latest.daypart.nightMix, latest.daypart.phase === "off");
	let lightKey = latest.daypart;
	const applyLight = (): void => {
		lightKey = latest.daypart;
		light = officeLighting(latest.daypart.nightMix, latest.daypart.phase === "off");
		lights.apply(light);
		post.applyLight(light.exposure, light.bloomWeight);
		floors.setNightMix(latest.daypart.nightMix, latest.daypart.phase === "off");
	};
	applyLight();
	floors.show(transition.frame(performance.now()).floor);

	// The asset file: baked shells, furniture, the character, sounds (all optional).
	void loadSceneAssets(opts.signal).then(async (assets) => {
		if (opts.signal.aborted) return;
		floors.setAssets(assets, qualityLevelAt(startIndex).lightmapSize);
		sfx.dispose();
		sfx = createOfficeSfx(eventSoundFiles(assets.sounds), assetUrl);
		sfx.setEnabled(soundOn);
		props.setSources(new Map([...propSources(assets)].map(([name, file]) => [name, assetUrl(file)])), opts.signal);
		const character = assets.character;
		if (character === null) return;
		const accessories = assets.accessories;
		const ok = await pool.load(
			{
				model: assetUrl(character.file),
				skins: character.skins === null ? null : { url: assetUrl(character.skins.file), atlas: character.skins },
				accessories: accessories === null ? null : { url: assetUrl(accessories.file), items: accessories.items },
			},
			opts.signal,
		);
		if (!ok || opts.signal.aborted) return;
		people.rebuild();
		lights.refreshCasters(people.meshes());
	});
	const prepareTimer = window.setTimeout(() => {
		floors.prepare(2);
		floors.prepare(3);
	}, PREPARE_AFTER_MS);

	const stats = new FrameStats(3600);
	// Resize at the start of the next frame, not mid-frame (WebGPU destroys the swap texture a frame may still use).
	let resizePending = false;
	let frames = 0;
	let warm = 0;
	let last = performance.now();
	const onFrame = (): void => {
		const now = performance.now();
		const dtMs = Math.min(100, now - last);
		last = now;
		// The quality scaler may change the canvas resolution, so it too runs before this frame draws: the
		// previous frame's duration decides (on WebGPU a resize after render() destroys textures the frame still submits).
		if (frames > 0) {
			if (warm < WARM_UP_FRAMES) {
				warm += 1;
				if (warm === WARM_UP_FRAMES) scaler.start();
			} else scaler.onFrame(dtMs);
		}
		if (resizePending) {
			resizePending = false;
			engine.resize();
		}
		const t = transition.frame(now);
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		const frame = camera.update(width, height, now, t.lift);
		floors.show(t.floor);
		const inView = (x: number, z: number): boolean => {
			const o = screenOffset(frame.yaw, frame.pitch, x - frame.target.x, 0.8 - frame.target.y, z - frame.target.z);
			return Math.abs(o.right) < frame.halfWidth + 1 && Math.abs(o.up) < frame.halfHeight + 1.5;
		};
		people.frame(frozen ? 0 : dtMs / 1000, t.floor, fullRate, inView, { x: frame.target.x, z: frame.target.z });
		const views = people.views();
		fx.frame(now / 1000, t.floor, views, frozen ? 0 : light.screenGlow, frozen ? 0 : light.deskLamp);
		overlay.update(scene, width, height, t.floor, views, boards);
		fade.style.opacity = t.fade > 0 ? t.fade.toFixed(2) : "";
		if (now < flickerUntil) post.applyLight(Math.sin(now / 37) > 0.2 ? 0.25 : light.exposure, light.bloomWeight);
		scene.render();
		frames += 1;
		stats.push(dtMs);
	};
	const gate = createRenderGate(host, (run) => {
		if (run) {
			last = performance.now();
			engine.runRenderLoop(onFrame);
		} else engine.stopRenderLoop();
	});
	const resize = new ResizeObserver(() => {
		resizePending = true;
	});
	resize.observe(host);
	const lost = engine.onContextLostObservable.add(() => {
		gate.contextLost();
		opts.onLost();
	});
	const removeTestApi = opts.testApi
		? exposeTestApi(() => ({
				backend,
				quality: scaler.level.id,
				floor: transition.frame(performance.now()).floor,
				drawCalls: instrumentation.drawCallsCounter.current,
				frames,
				fps: engine.getFps(),
				stats: stats.summary(),
				people: people.views().map((p) => ({ key: p.key, floor: p.floor, x: p.x, z: p.z, visible: p.visible, target: p.target, pose: p.pose, screen: overlay.screen.get(p.key) ?? null })),
				resetStats: () => stats.reset(),
			}))
		: () => undefined;

	let disposed = false;
	return {
		kind: "ready",
		world: {
			update(next, sound) {
				const wasOut = latest.state.power === "out";
				latest = next;
				transition.request(next.floor, performance.now());
				if (next.daypart.phase !== lightKey.phase || Math.abs(next.daypart.nightMix - lightKey.nightMix) > 0.002) applyLight();
				frozen = next.state.power === "out";
				scene.animationsEnabled = !frozen;
				if (frozen && !wasOut) {
					flickerUntil = performance.now() + FLICKER_MS;
					sfx.play("power-off");
				} else if (!frozen && wasOut) sfx.play("power-on");
				if (sound !== soundOn) {
					soundOn = sound;
					sfx.setEnabled(sound);
				}
				people.update(next.placements, next.state, next.now);
				fx.update(next.state);
			},
			bind: overlay.bind,
			dispose() {
				if (disposed) return;
				disposed = true;
				window.clearTimeout(prepareTimer);
				gate.dispose();
				resize.disconnect();
				overlay.dispose();
				engine.onContextLostObservable.remove(lost);
				removeTestApi();
				engine.stopRenderLoop();
				sfx.dispose();
				people.dispose();
				fx.dispose();
				floors.dispose();
				props.dispose();
				pool.dispose();
				lights.dispose();
				post.dispose();
				camera.dispose();
				kit.dispose();
				instrumentation.dispose();
				scene.dispose();
				engine.dispose();
				canvas.remove();
				fade.remove();
			},
		},
	};
}
