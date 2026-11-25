// What the session's events make the Live Map's city do: every move names
// its source event (packets out along a district's road when a call starts,
// back when it ends, red when it failed; pulses at a place), the camera's
// activity, the roads' numbers (calls, failures, the running calls and when
// each passes its kind's p95 of the session, the actor), the districts'
// presence and activity, the drones and their districts, the context, the
// thinking spin; and the shared geometry (points along a road, dashes, a
// drone's flight, the board over a district, the pipeline's slots).
import { describe, expect, it } from "vitest";
import {
	activityOf,
	dashes,
	dronePath,
	holoPanelRect,
	lookOf,
	movesOf,
	pathLength,
	pathPoint,
	pipelineSlots,
	roadOf,
	roadWidth,
	sameLook,
	subPath,
} from "../../src/machines/observatory/render/prop-map.ts";
import type { LiveMapEvent } from "../../src/machines/observatory/live-map-types.ts";
import { api, bottleneck, lifecycle, prompt, subagent, tool } from "../machines/observatory/live-map-fixtures.ts";
import { fixtureScene, played } from "./render-fixtures.ts";

const scene = fixtureScene();

function moves(events: LiveMapEvent[]) {
	const { state, animations } = played(events);
	const byId = new Map(state.log.map((e) => [e.id, e]));
	return animations.flatMap((a) => movesOf(a, byId.get(a.eventId), scene));
}

describe("moves", () => {
	it("a call sends a packet out along its district's road and back at its end, red when it failed", () => {
		const out = moves([prompt(1, 0), tool("r1", 10, { station: "FILES" })]).filter((m) => m.eventId === "tool:r1");
		expect(out).toEqual([expect.objectContaining({ kind: "packet-out", place: "files", tone: "normal", path: scene.places.files.route })]);
		const back = moves([prompt(1, 0), tool("r1", 10, { station: "FILES" }), tool("r1", 20, { station: "FILES", success: false })]).filter((m) => m.eventId === "tool:r1");
		expect(back.at(-1)).toMatchObject({ kind: "packet-back", tone: "error", path: [...scene.places.files.route].reverse() });
	});

	it("every move names its source event", () => {
		const all = moves([prompt(1, 0), api("a", 5), subagent("ag", 6), tool("r1", 10, { station: "MCP" }), lifecycle("permission_request", "q", 20), lifecycle("stop", "s", 30), bottleneck("b", 40, "FILES", "warn", true)]);
		expect(all.length).toBeGreaterThanOrEqual(7);
		expect(all.every((m) => m.eventId !== "")).toBe(true);
		expect(all.find((m) => m.eventId === "prompt:p1")).toMatchObject({ kind: "packet-back", place: "user-desk" });
		expect(all.find((m) => m.eventId === "event:q")).toMatchObject({ kind: "packet-out", place: "security", tone: "warn" });
		expect(all.find((m) => m.eventId === "bottleneck:b")).toMatchObject({ kind: "alarm", place: "files", tone: "warn" });
	});

	it("CI followed after a push pulses the Git district, green or red by its result", () => {
		const m = moves([prompt(1, 0), lifecycle("ci_started", "a", 10, { station: "GIT", label: "web" }), lifecycle("ci_finished", "b", 20, { station: "GIT", label: "web", flag: false })]);
		expect(m.find((x) => x.eventId === "event:a")).toMatchObject({ kind: "pulse", place: "git", tone: "normal" });
		expect(m.find((x) => x.eventId === "event:b")).toMatchObject({ kind: "pulse", place: "git", tone: "error" });
	});
});

describe("the activity and the look", () => {
	it("follows the newest running call, a test run, thinking and waiting", () => {
		expect(activityOf(played([prompt(1, 0), tool("a", 10), tool("b", 20, { station: "MCP" })]).state)).toEqual({ mode: "exec", newestPlace: "mcp", testing: false });
		expect(activityOf(played([prompt(1, 0), tool("t", 10, { station: "TESTING" }), tool("b", 20, { station: "SANDBOX" })]).state).testing).toBe(true);
		expect(activityOf(played([prompt(1, 0)]).state).mode).toBe("think");
		expect(activityOf(played([prompt(1, 0), lifecycle("permission_request", "q", 10)]).state).mode).toBe("wait");
		expect(activityOf(played([prompt(1, 0), lifecycle("stop", "s", 10)]).state).mode).toBe("idle");
	});

	it("gives each road its calls, failures, p95 and running calls with the moment they pass that p95", () => {
		const { state } = played([
			prompt(1, 0),
			tool("a", 10, { success: true, durationMs: 100 }),
			tool("b", 200, { success: false, durationMs: 300 }),
			tool("c", 600),
		]);
		const files = lookOf(state, scene).roads.find((r) => r.place === "files");
		expect(files).toMatchObject({ calls: 2, failures: 1, p95Ms: 300 });
		expect(files?.running).toEqual([{ eventId: "tool:c", agentId: "", startedAt: expect.any(Number) as number, overAt: (files?.running[0]?.startedAt ?? 0) + 300 }]);
		const unused = lookOf(state, scene).roads.find((r) => r.place === "mcp");
		expect(unused).toMatchObject({ calls: 0, running: [] });
	});

	it("dims the districts not taking part while the AI works, and background ones never used", () => {
		const busy = lookOf(played([prompt(1, 0), tool("a", 10)]).state, scene);
		expect(busy.places.files).toMatchObject({ active: true, involved: true, presence: 1 });
		expect(busy.places.mcp.presence).toBeLessThan(0.5);
		const idle = lookOf(played([prompt(1, 0), lifecycle("stop", "s", 10)]).state, scene);
		expect(idle.places.memory.presence).toBeLessThan(idle.places.files.presence);
	});

	it("flies a subagent's drone to the district of its call, home when it has none", () => {
		const { state } = played([prompt(1, 0), subagent("ag", 5), subagent("ag2", 6), tool("r", 10, { agentId: "ag", station: "SANDBOX" })]);
		const look = lookOf(state, scene);
		expect(look.drones).toEqual([
			{ agentId: "ag", agentType: "Explore", target: "sandbox", slot: 0 },
			{ agentId: "ag2", agentType: "Explore", target: "orchestrator", slot: 1 },
		]);
		const job = look.roads.find((r) => r.place === "sandbox")?.running[0];
		expect(job?.agentId).toBe("ag");
	});

	it("names the event the model thinks for, and is the same look for the same state", () => {
		const { state } = played([prompt(1, 0)]);
		expect(lookOf(state, scene).thinkingFor).toBe("prompt:p1");
		expect(sameLook(lookOf(state, scene), lookOf(state, scene))).toBe(true);
		expect(lookOf(played([prompt(1, 0), lifecycle("stop", "s", 5)]).state, scene).thinkingFor).toBeNull();
	});
});

describe("geometry", () => {
	const path = [
		[0, 0],
		[100, 0],
		[100, 100],
	] as const;

	it("walks a path by length, also on diagonal roads", () => {
		expect(pathLength(path)).toBe(200);
		expect(pathPoint(path, 0.5)).toEqual([100, 0]);
		expect(pathPoint(path, 0.75)).toEqual([100, 50]);
		expect(pathPoint([[0, 0], [30, 40]], 0.5)).toEqual([15, 20]);
		expect(subPath(path, 0.25)).toEqual([
			[0, 0],
			[50, 0],
		]);
	});

	it("cuts dashes that move along with the offset", () => {
		const a = dashes(path, 20, 10, 0);
		expect(a[0]).toEqual([
			[0, 0],
			[20, 0],
		]);
		const b = dashes(path, 20, 10, 5);
		expect(b[0]?.[1]).toEqual([25, 0]);
		expect(dashes([[0, 0]], 20, 10, 0)).toEqual([]);
	});

	it("widens a road with its calls", () => {
		expect(roadWidth(0)).toBeLessThan(roadWidth(5));
		expect(roadWidth(1_000)).toBeLessThanOrEqual(roadWidth(10_000));
	});

	it("flies a drone along the roads through the core's base and keeps boards and slots on the scene", () => {
		const home: [number, number] = [scene.core.centre[0] + 100, scene.core.centre[1]];
		const out = dronePath(scene, home, "orchestrator", "files", home);
		expect(out[0]).toEqual(home);
		expect(out.slice(1, 1 + roadOf(scene, "files").length)).toEqual(roadOf(scene, "files"));
		const back = dronePath(scene, [1, 1], "files", "orchestrator", home);
		expect(back.at(-1)).toEqual(home);
		for (const id of ["files", "sandbox", "core", "user-desk"] as const) {
			const r = holoPanelRect(scene, id);
			expect(r.x).toBeGreaterThanOrEqual(0);
			expect(r.y).toBeGreaterThanOrEqual(0);
			expect(r.x + r.w).toBeLessThanOrEqual(scene.space.width);
		}
		const slots = pipelineSlots(scene);
		expect(slots.steps).toHaveLength(4);
		const git = scene.places.git.rect;
		for (const s of slots.steps) expect(s.x >= git.x && s.x + s.w <= git.x + git.w).toBe(true);
	});
});
