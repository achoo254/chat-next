// The 3D office (plan decision 9): boots Babylon on a canvas in the host
// element, builds the whole plan from the layout (blocks first, baked models
// as the asset file lists them), and from then on only reads what the Office
// tab hands it (the store's state, everyone's placement, the framing asked
// for, the hour) through `update`. Each frame: the camera, the level of detail
// by zoom, people walking and posing, room effects, the HTML labels and
// boards, render. The loop runs only while the page shows, the canvas is on
// screen and the app is in the foreground. Loaded on demand (its own chunk
// with Babylon).
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { SceneLoaderFlags } from "@babylonjs/core/Loading/sceneLoaderFlags";
import { Scene } from "@babylonjs/core/scene";
import { BOARD_ROOMS } from "../machines/office/office-boards.tsx";
import type { OfficeRendererProps } from "../machines/office/office-renderer.ts";
import type { OfficeSfx } from "./audio/office-sfx.ts";
import { createOfficeSfx, eventSoundFiles } from "./audio/office-sfx.ts";
import { createLifeSounds, type LifeSounds } from "./audio/life-sounds.ts";
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
import { CAMERA_DISTANCE, pixelsPerMetre, screenOffset } from "./scene/fit-office-camera.ts";
import { createOfficeCamera } from "./scene/office-camera.ts";
import { officeLighting } from "./scene/office-lighting.ts";
import { createOfficeLights } from "./scene/office-lights.ts";
import { createPostProcessing } from "./scene/post-processing.ts";
import { createPropLibrary } from "./scene/prop-library.ts";
import { createRoomFx } from "./scene/room-fx.ts";
import { assetUrl, loadSceneAssets, propSources } from "./scene/scene-assets.ts";
import { SCENE_LAYOUT } from "./scene/scene-layout.ts";
import { createZoneLibrary } from "./scene/zone-library.ts";
import { nextFar } from "./scene/zoom-detail.ts";
import { cameraPlan, exposeTestApi } from "./world-support.ts";

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
/** Light flicker when the power goes out. */
const FLICKER_MS = 1_200;
/** A board's HTML pin sits this far over its anchor's height (the board's top), and at least this high. */
const BOARD_PIN_RISE = 0.55;
const BOARD_PIN_MIN_Y = 2.15;

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

	const scene = new Scene(engine);
	scene.skipPointerMovePicking = true;
	const instrumentation = new SceneInstrumentation(scene);
	const kit = createBlockKit(scene);
	const props = createPropLibrary(scene, kit);
	const zones = createZoneLibrary(scene, kit, props, SCENE_LAYOUT, layout.zones, opts.signal);
	const lights = createOfficeLights(scene, SCENE_LAYOUT.footprint);
	const camera = createOfficeCamera(scene, canvas, cameraPlan(layout, SCENE_LAYOUT.footprint), opts.props.framing, opts.reducedMotion);
	const post = createPostProcessing(scene, camera.camera, "neutral");
	const pool = createCharacterPool(scene);
	let sfx: OfficeSfx = createOfficeSfx(new Map(), assetUrl);
	let lifeSounds: LifeSounds = createLifeSounds(new Map(), assetUrl);
	// What happens out of view stays quiet, but an approval waiting on the viewer always rings.
	const people = createOfficePeople(layout, createRouter(layout), pool, (event, inView) => {
		if (event === "approval" || inView) sfx.play(event);
	});
	const fx = createRoomFx(scene, kit, SCENE_LAYOUT);
	const overlay = createOfficeOverlay();
	const boards: BoardPin[] = [
		...layout.anchors
			.filter((a) => a.kind === "board" && a.room !== null && BOARD_ROOMS.includes(a.room))
			.map((a) => ({ id: a.id, x: a.x, y: Math.max(BOARD_PIN_MIN_Y, a.y + BOARD_PIN_RISE), z: a.z, shrinksWhenFar: true })),
		// The meeting room's "+N" over its table.
		...layout.anchors.filter((a) => a.kind === "meeting").slice(0, 1).map((a) => ({ id: "overflow", x: a.x, y: 1.6, z: a.z, shrinksWhenFar: false })),
	];
	/** The people the shadow light draws: those in view, re-listed when that set changes. */
	let casterKeys = "";
	const refreshCasters = (): void => {
		casterKeys = people.views().filter((p) => p.visible).map((p) => p.key).join("|");
		lights.refreshCasters(people.meshes(true));
	};
	const startIndex = opts.pinnedQuality ?? startingQualityLevel(opts.coarsePointer);
	let fullRate = qualityLevelAt(0).fullRateCharacters;
	const scaler = createQualityScaler(engine, startIndex, opts.pinnedQuality !== null, (level) => {
		// SSAO2 fails to bind its noise texture on WebGPU here (blank frames): WebGL2 only.
		post.applyQuality(backend === "webgpu" ? { ...level, ssao: false } : level);
		lights.setShadowMapSize(level.shadowMapSize, () => people.meshes(true));
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
	let light = officeLighting(latest.daypart.nightMix);
	let lightKey = latest.daypart;
	/** Zoomed far out: small props hidden, idle people's labels shrunk to dots (zoom-detail.ts). */
	let far = false;
	let pxPerMetre = 0;
	const applyLight = (): void => {
		lightKey = latest.daypart;
		light = officeLighting(latest.daypart.nightMix);
		lights.apply(light);
		post.applyLight(light.exposure, light.bloomWeight);
		zones.setNightMix(latest.daypart.nightMix);
	};
	applyLight();

	// The asset file: baked shells, furniture, the character, sounds (all optional).
	void loadSceneAssets(opts.signal).then(async (assets) => {
		if (opts.signal.aborted) return;
		zones.setAssets(assets, qualityLevelAt(startIndex).lightmapSize);
		sfx.dispose();
		sfx = createOfficeSfx(eventSoundFiles(assets.sounds), assetUrl);
		sfx.setEnabled(soundOn);
		lifeSounds.dispose();
		lifeSounds = createLifeSounds(assets.sounds, assetUrl);
		lifeSounds.setEnabled(soundOn);
		props.setSources(new Map([...propSources(assets)].map(([name, file]) => [name, assetUrl(file)])), opts.signal);
		const robot = assets.serviceRobot;
		// The services' robot loads beside the character (neither waits for the other); each rebuilds everyone when in.
		if (robot !== null) {
			void pool.loadRobot(assetUrl(robot.file), robot, opts.signal).then((ok) => {
				if (!ok || opts.signal.aborted) return;
				people.rebuild();
				refreshCasters();
			});
		}
		// A job title's model loads the first time someone of the title is drawn; several arriving together rebuild everyone once.
		let staffRebuild: ReturnType<typeof setTimeout> | undefined;
		pool.onStaffModel(() => {
			if (staffRebuild !== undefined) return;
			staffRebuild = setTimeout(() => {
				staffRebuild = undefined;
				if (opts.signal.aborted) return;
				people.rebuild();
				refreshCasters();
			}, 120);
		});
		const character = assets.character;
		if (character === null) return;
		const accessories = assets.accessories;
		const ok = await pool.load(
			{
				model: assetUrl(character.file),
				director: assets.directorCharacter === null ? null : assetUrl(assets.directorCharacter.file),
				staff: new Map([...assets.staffCharacters].map(([model, entry]) => [model, assetUrl(entry.file)])),
				skins: character.skins === null ? null : { url: assetUrl(character.skins.file), atlas: character.skins },
				accessories: accessories === null ? null : { url: assetUrl(accessories.file), items: accessories.items },
			},
			opts.signal,
		);
		if (!ok || opts.signal.aborted) return;
		people.rebuild();
		refreshCasters();
	});

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
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		const frame = camera.update(width, height, now);
		pxPerMetre = pixelsPerMetre(frame, height);
		far = nextFar(far, pxPerMetre);
		zones.setSmallProps(!far);
		const inView = (x: number, z: number): boolean => {
			const o = screenOffset(frame.yaw, frame.pitch, x - frame.target.x, 0.8 - frame.target.y, z - frame.target.z);
			return Math.abs(o.right) < frame.halfWidth + 1 && Math.abs(o.up) < frame.halfHeight + 1.5;
		};
		people.frame(frozen ? 0 : dtMs / 1000, fullRate, inView, { x: frame.target.x, z: frame.target.z });
		const views = people.views();
		const seen = views.filter((p) => p.visible).map((p) => p.key).join("|");
		if (seen !== casterKeys) refreshCasters();
		fx.frame(now / 1000, views, frozen ? 0 : light.screenGlow, frozen ? 0 : light.deskLamp);
		lifeSounds.frame(now / 1000, frozen ? [] : views);
		overlay.update(scene, width, height, views, boards, far);
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
		? exposeTestApi(() => {
				const heads = people.headOffsets();
				const probes = people.probes();
				return {
					backend,
					quality: scaler.level.id,
					zoom: camera.user.zoom,
					pixelsPerMetre: pxPerMetre,
					dots: overlay.dots,
					drawCalls: instrumentation.drawCallsCounter.current,
					frames,
					fps: engine.getFps(),
					stats: stats.summary(),
					camera: { zoom: camera.user.zoom, yaw: camera.user.yaw },
					people: people.views().map((p) => ({
						key: p.key,
						x: p.x,
						z: p.z,
						visible: p.visible,
						target: p.target,
						pose: p.pose,
						model: p.model,
						dozing: p.dozing,
						heading: p.heading,
						head: heads.get(p.key) ?? null,
						probe: probes.get(p.key) ?? null,
						screen: overlay.screen.get(p.key) ?? null,
					})),
					resetStats: () => stats.reset(),
				};
			})
		: () => undefined;

	let disposed = false;
	return {
		kind: "ready",
		world: {
			update(next, sound) {
				const wasOut = latest.state.power === "out";
				latest = next;
				camera.setFraming(next.framing);
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
					lifeSounds.setEnabled(sound);
				}
				people.update(next.placements, next.state, next.now, next.talks);
				fx.update(next.state);
			},
			bind: overlay.bind,
			dispose() {
				if (disposed) return;
				disposed = true;
				gate.dispose();
				resize.disconnect();
				overlay.dispose();
				engine.onContextLostObservable.remove(lost);
				removeTestApi();
				engine.stopRenderLoop();
				sfx.dispose();
				lifeSounds.dispose();
				people.dispose();
				fx.dispose();
				zones.dispose();
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
			},
		},
	};
}
