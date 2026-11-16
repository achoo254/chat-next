// The 3D part of the asset file (scene-assets.ts), the shell GLB's extras
// (shell-extras.ts), how people are dressed (character-look.ts) and which
// sound file each scene event plays (office-sfx.ts): the snapshot of the
// delivered manifest, the live manifest and shell GLBs in public/office, and
// broken input that must fall back instead of throwing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutHash } from "../../src/machines/office/office-assets.ts";
import { eventSoundFiles, SOUND_FILES } from "../../src/office-3d/audio/office-sfx.ts";
import { ACCESSORY_ITEMS, personLook, skinCellFor } from "../../src/office-3d/character/character-look.ts";
import { lightmapPair, NO_SCENE_ASSETS, parseSceneAssets, propSources, skinCell, type SceneAssets } from "../../src/office-3d/scene/scene-assets.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { gammaScale, NO_SHELL_EXTRAS, parseShellExtras } from "../../src/office-3d/scene/shell-extras.ts";

const PUBLIC_OFFICE = join(__dirname, "../../public/office");
const fixture: unknown = JSON.parse(readFileSync(join(__dirname, "fixtures/office-assets.json"), "utf8"));
const FIXTURE_HASH = "07e38c35bdf592966eacb88afcec346d82cbbc1251c3df1efc25d309155e2d5a";

/** The JSON chunk of a GLB file. */
function glbJson(path: string): unknown {
	const bytes = readFileSync(path);
	const length = bytes.readUInt32LE(12);
	return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("scene assets: the delivered manifest", () => {
	const assets = parseSceneAssets(fixture, FIXTURE_HASH);

	it("reads every floor's shell, lightmaps, props GLB and model list", () => {
		expect([...assets.floors.keys()]).toEqual([1, 2, 3]);
		const one = assets.floors.get(1);
		expect(one?.shell).toBe("office-floor-1.840e399c.glb");
		expect(one?.props).toBe("office-props-floor-1.0ffcdbdb.glb");
		expect(one?.models).toHaveLength(30);
		expect(one?.models).toEqual(expect.arrayContaining(["desk", "chair", "monitor", "sofa", "paper-stack"]));
		expect(assets.floors.get(2)?.models).toEqual([]);
		if (one === undefined) throw new Error("floor 1 missing");
		expect(lightmapPair(one, 1024)).toEqual({ day: "lightmap-floor-1-day-1024.426f0710.webp", night: "lightmap-floor-1-night-1024.97efd27f.webp" });
		expect(lightmapPair(one, 2048)?.night).toBe("lightmap-floor-1-night-2048.c720e4e2.webp");
	});

	it("reads the character with its clips and the skin atlas grid", () => {
		expect(assets.character?.file).toBe("character.97b412fb.glb");
		expect(assets.character?.clips).toEqual(expect.arrayContaining(["Typing", "Victory", "Walk", "Sitting_Idle", "Sitting_Writing"]));
		expect(assets.character?.skins).toMatchObject({ file: "character-skins.a220a2f9.webp", columns: 4, rows: 3, count: 10 });
		expect(assets.character?.skins?.names[1]).toBe("teal-overalls");
	});

	it("reads the accessories with their bones and scales, and the sounds", () => {
		expect(assets.accessories?.file).toBe("accessories.b3055046.glb");
		expect(assets.accessories?.items.get("glasses")).toEqual({ bone: "head", scale: 1.8 });
		expect(assets.accessories?.items.get("mug")).toEqual({ bone: "hand_r", scale: 1 });
		expect(assets.sounds.get("typing")).toEqual({ file: "sfx/typing.aa1b7357.mp3", loop: true, seconds: 1.6 });
		expect(assets.sounds.size).toBe(9);
	});

	it("maps each model name to the first floor's props GLB that holds it", () => {
		const sources = propSources(assets);
		expect(sources.get("desk")).toBe("office-props-floor-1.0ffcdbdb.glb");
		expect(sources.has("coffee-table")).toBe(false);
		expect(sources.size).toBe(30);
	});
});

describe("scene assets: the live manifest", () => {
	it("is for the shipped layout, and every file it names exists", async () => {
		const live: unknown = JSON.parse(readFileSync(join(PUBLIC_OFFICE, "office-assets.json"), "utf8"));
		const assets = parseSceneAssets(live, await layoutHash());
		expect(assets).not.toBe(NO_SCENE_ASSETS);
		const files = [
			...[...assets.floors.values()].flatMap((f) => [f.shell, f.props, ...Object.values(f.lightmaps.day), ...Object.values(f.lightmaps.night)]),
			assets.character?.file,
			assets.character?.skins?.file,
			assets.accessories?.file,
			...[...assets.sounds.values()].map((s) => s.file),
		].filter((f): f is string => typeof f === "string");
		expect(files.length).toBeGreaterThan(10);
		for (const f of files) expect(existsSync(join(PUBLIC_OFFICE, f)), f).toBe(true);
	});

	it("has shells whose extras place props by the layout's own names", async () => {
		const live: unknown = JSON.parse(readFileSync(join(PUBLIC_OFFICE, "office-assets.json"), "utf8"));
		const assets = parseSceneAssets(live, await layoutHash());
		const layoutNames = new Set(SCENE_LAYOUT.floors.flatMap((f) => [...f.props, ...f.smallProps].map((p) => p.name)));
		for (const [level, floor] of assets.floors) {
			if (floor.shell === null) continue;
			const extras = parseShellExtras(glbJson(join(PUBLIC_OFFICE, floor.shell)));
			expect(extras.places, `floor ${level}`).not.toBeNull();
			for (const place of extras.places ?? []) expect(layoutNames.has(place.name), place.name).toBe(true);
			expect(extras.intensityScale).toBe(2);
		}
	});

	it("has a props GLB node for every model the manifest lists", async () => {
		const live: unknown = JSON.parse(readFileSync(join(PUBLIC_OFFICE, "office-assets.json"), "utf8"));
		const assets = parseSceneAssets(live, await layoutHash());
		for (const floor of assets.floors.values()) {
			if (floor.props === null || floor.models.length === 0) continue;
			const json = glbJson(join(PUBLIC_OFFICE, floor.props)) as { nodes?: { name?: string }[] };
			const nodes = new Set((json.nodes ?? []).map((n) => n.name));
			for (const model of floor.models) expect(nodes.has(model), model).toBe(true);
		}
	});
});

describe("scene assets: the service robot", () => {
	it("reads the live robot, and its GLB has every part it names", async () => {
		const live: unknown = JSON.parse(readFileSync(join(PUBLIC_OFFICE, "office-assets.json"), "utf8"));
		const robot = parseSceneAssets(live, await layoutHash()).serviceRobot;
		expect(robot).not.toBeNull();
		if (robot === null) return;
		expect(robot.heightM).toBeGreaterThan(0);
		const json = glbJson(join(PUBLIC_OFFICE, robot.file)) as { nodes?: { name?: string }[] };
		const nodes = new Set((json.nodes ?? []).map((n) => n.name));
		for (const part of Object.values(robot.parts)) expect(nodes.has(part), part).toBe(true);
	});

	it("is optional, and left out whole when a piece is bad (services stay people)", () => {
		const good = { file: "robot.glb", heightM: 0.62, parts: { body: "b", screen: "s", eyes: "e", light: "l" } };
		const read = (serviceRobot: unknown) => parseSceneAssets({ ...(fixture as object), serviceRobot }, FIXTURE_HASH).serviceRobot;
		expect(parseSceneAssets(fixture, FIXTURE_HASH).serviceRobot).toBeNull();
		expect(read(good)).toEqual(good);
		expect(read({ ...good, file: "../robot.glb" })).toBeNull();
		expect(read({ ...good, heightM: 0 })).toBeNull();
		expect(read({ ...good, heightM: 40 })).toBeNull();
		expect(read({ ...good, parts: { ...good.parts, eyes: "bad name" } })).toBeNull();
		expect(read({ ...good, parts: { body: "b" } })).toBeNull();
		expect(read("robot")).toBeNull();
	});
});

describe("scene assets: broken input", () => {
	it("uses nothing from a file for another layout or version, or not an object", () => {
		expect(parseSceneAssets(fixture, "other")).toBe(NO_SCENE_ASSETS);
		expect(parseSceneAssets({ ...(fixture as object), formatVersion: 2 }, FIXTURE_HASH)).toBe(NO_SCENE_ASSETS);
		expect(parseSceneAssets("nope", FIXTURE_HASH)).toBe(NO_SCENE_ASSETS);
		expect(parseSceneAssets(null, FIXTURE_HASH)).toBe(NO_SCENE_ASSETS);
	});

	it("drops each bad piece on its own: climbing paths, odd levels, bad names, bad grids", () => {
		const bad = clone(fixture) as { floors: Record<string, unknown>[]; character: Record<string, unknown>; accessories: Record<string, unknown>; sfx: Record<string, unknown> };
		const [one, two, three] = bad.floors;
		if (one === undefined || two === undefined || three === undefined) throw new Error("fixture floors missing");
		one.scene = { ...(one.scene as object), shell: "../secret.glb", models: ["desk", "Bad Name!", 7, "desk"] };
		two.scene = { ...(two.scene as object), props: "/etc/passwd" };
		three.level = 7;
		bad.character = { ...bad.character, skins: { file: "skins.webp", columns: 0, rows: 3, count: 4 } };
		bad.accessories = { file: "acc.glb", items: { glasses: { bone: "head", scale: -1 }, "../x": { bone: "head" }, cup: { bone: "hand r" }, mug: { bone: "hand_r" } } };
		bad.sfx = { sounds: { cheer: { file: "../cheer.mp3" }, ding: { file: "sfx/ding.mp3", loop: "yes", seconds: -2 } } };
		const assets = parseSceneAssets(bad, FIXTURE_HASH);
		expect(assets.floors.get(1)?.shell).toBeNull();
		expect(assets.floors.get(1)?.models).toEqual(["desk"]);
		expect(assets.floors.get(2)?.props).toBeNull();
		expect(assets.floors.has(3)).toBe(false);
		expect(assets.character?.file).toBe("character.97b412fb.glb");
		expect(assets.character?.skins).toBeNull();
		expect([...(assets.accessories?.items.keys() ?? [])]).toEqual(["mug"]);
		expect([...assets.sounds]).toEqual([["ding", { file: "sfx/ding.mp3", loop: false, seconds: 0 }]]);
	});

	it("reads a manifest without the 3D parts as an empty scene that still has its floors' pictures elsewhere", () => {
		const assets = parseSceneAssets({ formatVersion: 1, layoutSha256: "h", floors: [{ level: 1, views: {} }], character: { file: 3 }, accessories: { file: "a.glb", items: {} } }, "h");
		expect(assets.floors.size).toBe(0);
		expect(assets.character).toBeNull();
		expect(assets.accessories).toBeNull();
		expect(assets.sounds.size).toBe(0);
	});

	it("caps the skin count at the grid and needs both times of day for a lightmap pair", () => {
		const assets: SceneAssets = parseSceneAssets(
			{ formatVersion: 1, layoutSha256: "h", floors: [{ level: 1, scene: { lightmaps: { day: { 1024: "d.webp" } } } }], character: { file: "c.glb", skins: { file: "s.webp", columns: 2, rows: 2, count: 9 } } },
			"h",
		);
		expect(assets.character?.skins?.count).toBe(4);
		const floor = assets.floors.get(1);
		if (floor === undefined) throw new Error("floor 1 missing");
		expect(lightmapPair(floor, 1024)).toBeNull();
	});
});

describe("shell extras", () => {
	it("reads instances, the lightmap scale and window colours, dropping broken entries", () => {
		const extras = parseShellExtras({
			asset: {
				extras: {
					lightmap: { intensityScale: 2 },
					windowViewColours: { day: [1, 0.9, 0.8], night: [0.2, 0.2, 0.5] },
					instances: { desk: [[1, 0, 2, 3.14], [1, 0], ["x", 0, 0, 0], [1e6, 0, 0, 0]], "bad name": [[0, 0, 0, 0]], chair: [[0, 0, 1]] },
				},
			},
		});
		expect(extras.places).toEqual([
			{ name: "desk", x: 1, y: 0, z: 2, rotY: 3.14, anchor: "" },
			{ name: "chair", x: 0, y: 0, z: 1, rotY: 0, anchor: "" },
		]);
		expect(extras.intensityScale).toBe(2);
		expect(extras.windowColours).toEqual({ day: [1, 0.9, 0.8], night: [0.2, 0.2, 0.5] });
	});

	it("reads no extras, empty instances or odd values as not given", () => {
		expect(parseShellExtras(null)).toBe(NO_SHELL_EXTRAS);
		expect(parseShellExtras({ asset: {} })).toBe(NO_SHELL_EXTRAS);
		expect(parseShellExtras({ asset: { extras: { instances: {}, lightmap: { intensityScale: -1 }, windowViewColours: { day: [1, 1] } } } })).toEqual(NO_SHELL_EXTRAS);
	});

	it("undoes the half-intensity bake in gamma space", () => {
		expect(gammaScale(2)).toBeCloseTo(Math.pow(2, 1 / 2.2), 6);
		expect(gammaScale(1)).toBe(1);
	});
});

describe("skins and accessories", () => {
	const atlas = { file: "s.webp", columns: 4, rows: 3, count: 10, names: [] };

	it("maps a skin index to its atlas cell, left to right then top to bottom, wrapping", () => {
		expect(skinCell(atlas, 0)).toEqual({ uScale: 0.25, vScale: 1 / 3, uOffset: 0, vOffset: 0 });
		expect(skinCell(atlas, 5)).toEqual({ uScale: 0.25, vScale: 1 / 3, uOffset: 0.25, vOffset: 1 / 3 });
		expect(skinCell(atlas, 9)).toEqual({ uScale: 0.25, vScale: 1 / 3, uOffset: 0.25, vOffset: 2 / 3 });
		expect(skinCell(atlas, 10)).toEqual(skinCell(atlas, 0));
		expect(skinCell(atlas, -1)).toEqual(skinCell(atlas, 9));
	});

	it("keeps the concept skin for the director and spreads everyone else over the other cells, stably", () => {
		expect(skinCellFor({ kind: "director", key: "director" }, 10)).toBe(0);
		const cells = ["scout#1", "scout#2", "tester#1", "researcher#1", "planner#1", "debugger#1", "code-reviewer#1"].map((key) => skinCellFor({ kind: "employee", key }, 10));
		for (const cell of cells) expect(cell).toBeGreaterThanOrEqual(1);
		for (const cell of cells) expect(cell).toBeLessThan(10);
		expect(new Set(cells).size).toBeGreaterThan(3);
		expect(skinCellFor({ kind: "employee", key: "scout#1" }, 10)).toBe(cells[0]);
		expect(skinCellFor({ kind: "employee", key: "scout#1" }, 1)).toBe(0);
	});

	it("gives employees their cast accessory by the asset file's names, nobody else one", () => {
		const member = (agentType: string): Parameters<typeof personLook>[0] => ({
			key: `${agentType}#1`,
			kind: "employee",
			actor: null,
			member: { key: `${agentType}#1`, agentType, ordinal: 1, actorId: "a", desk: null, nested: false, firstEnteredAt: 0 },
		});
		expect(personLook(member("code-reviewer")).accessory).toBe("glasses");
		expect(personLook(member("tester")).accessory).toBe("hard-hat");
		expect(personLook(member("researcher")).accessory).toBe("book-stack");
		expect(personLook(member("explore")).accessory).toBeNull();
		expect(personLook(member("docs-manager")).accessory).toBeNull();
		expect(personLook({ key: "director", kind: "director", actor: null, member: null }).accessory).toBeNull();
		expect(Object.values(ACCESSORY_ITEMS).filter((v) => v !== null)).toHaveLength(6);
	});
});

describe("office sounds", () => {
	it("maps scene events to the asset file's sound names, leaving the rest to tones", () => {
		const assets = parseSceneAssets(fixture, FIXTURE_HASH);
		const files = eventSoundFiles(assets.sounds);
		expect(files.get("arrive-lift")).toBe("sfx/elevator-ding.745bd5a2.mp3");
		expect(files.get("start-work")).toBe("sfx/typing.aa1b7357.mp3");
		expect(files.get("cheer")).toBe("sfx/cheer.8c1362c0.mp3");
		expect(files.get("smoke")).toBe("sfx/steam-puff.c4e5a5e1.mp3");
		expect(files.get("approval")).toBe("sfx/phone-ring.5b6332fd.mp3");
		expect(files.has("power-off")).toBe(false);
		expect(eventSoundFiles(new Map([["light-switch", { file: "sfx/light.mp3", loop: false, seconds: 0.3 }]])).get("power-on")).toBe("sfx/light.mp3");
		expect(Object.keys(SOUND_FILES)).toHaveLength(7);
	});
});
