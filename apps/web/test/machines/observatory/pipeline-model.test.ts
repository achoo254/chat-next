// The Git · CI/CD pipeline from a session's events: steps from the tool
// calls' flags (commit 1, push 2, deploy 4, ci 128), CI also from the
// lifecycle events the agent sends while it follows GitHub Actions after a
// push (ci_started / ci_finished: label = workflow, flag = success, number =
// duration), several workflows folded into one CI step, a new commit
// resetting the steps after it, prod lit by a successful deploy; a finish
// without a flag, or a run too long without one, is unknown.
import { describe, expect, it } from "vitest";
import { CI_STALE_MS, pipelineAt, pipelineOf } from "../../../src/machines/observatory/pipeline-model.ts";
import { played } from "../../observatory/render-fixtures.ts";
import { lifecycle, prompt, tool } from "./live-map-fixtures.ts";

const git = (use: string, ms: number, flags: number, end?: { ok: boolean; took: number }) =>
	tool(use, ms, { toolName: "Bash", station: "GIT", target: "git", stationFlags: flags, ...(end === undefined ? {} : { success: end.ok, durationMs: end.took }) });
const ci = (name: "ci_started" | "ci_finished", key: string, ms: number, label: string, over: { flag?: boolean; number?: number } = {}) => lifecycle(name, key, ms, { station: "GIT", label, ...over });

const pipe = (events: Parameters<typeof played>[0]) => pipelineOf(played(events).state.log);

describe("the release pipeline", () => {
	it("is idle with no release call", () => {
		const p = pipe([prompt(1, 0), tool("r1", 10, { success: true })]);
		expect(Object.values(p.steps).map((s) => s.status)).toEqual(["idle", "idle", "idle", "idle"]);
		expect(p.prod).toBe(false);
	});

	it("follows commit, push, CI (a gh call) and deploy from the flags, and lights prod", () => {
		const p = pipe([prompt(1, 0), git("c", 10, 1, { ok: true, took: 400 }), git("p", 500, 2, { ok: true, took: 1_300 }), git("w", 2_000, 128, { ok: true, took: 6_500 }), git("d", 9_000, 4)]);
		expect(p.steps.commit).toMatchObject({ status: "ok", durationMs: 400, eventId: "tool:c" });
		expect(p.steps.push.status).toBe("ok");
		expect(p.steps.ci).toMatchObject({ status: "ok", durationMs: 6_500 });
		expect(p.steps.deploy).toMatchObject({ status: "run", durationMs: null });
		expect(p.prod).toBe(false);
		const done = pipe([prompt(1, 0), git("d", 10, 4, { ok: true, took: 4_800 })]);
		expect(done.prod).toBe(true);
	});

	it("reads CI after a push from ci_* lifecycle events, also when they come in a later turn", () => {
		const p = pipe([
			prompt(1, 0),
			git("c", 10, 1, { ok: true, took: 300 }),
			git("p", 400, 2, { ok: true, took: 1_000 }),
			lifecycle("stop", "s", 1_500),
			ci("ci_started", "a", 2_000, "CI web"),
			prompt(2, 3_000),
			tool("r", 3_100, { success: true }),
		]);
		expect(p.steps.commit.status).toBe("ok");
		expect(p.steps.ci).toMatchObject({ status: "run", startedAt: expect.any(Number) as number });
		expect(p.ci).toEqual({ total: 1, running: 1, failed: 0 });
	});

	it("folds several workflows: running while one runs, failed when one failed, with their count", () => {
		const base = [prompt(1, 0), git("p", 10, 2, { ok: true, took: 100 }), ci("ci_started", "a", 200, "web"), ci("ci_started", "b", 210, "agent")];
		expect(pipe(base).steps.ci.status).toBe("run");
		const oneDone = pipe([...base, ci("ci_finished", "c", 5_000, "web", { flag: true, number: 4_800 })]);
		expect(oneDone.steps.ci.status).toBe("run");
		expect(oneDone.ci).toEqual({ total: 2, running: 1, failed: 0 });
		const failed = pipe([...base, ci("ci_finished", "c", 5_000, "web", { flag: true, number: 4_800 }), ci("ci_finished", "d", 6_000, "agent", { flag: false, number: 5_790 })]);
		expect(failed.steps.ci.status).toBe("err");
		expect(failed.ci).toEqual({ total: 2, running: 0, failed: 1 });
		const passed = pipe([...base, ci("ci_finished", "c", 5_000, "web", { flag: true, number: 4_800 }), ci("ci_finished", "d", 6_000, "agent", { flag: true, number: 5_790 })]);
		expect(passed.steps.ci.status).toBe("ok");
	});

	it("reads a ci_finished without a flag as unknown (neither ok nor failed), never over a known outcome", () => {
		const base = [prompt(1, 0), git("p", 10, 2, { ok: true, took: 100 }), ci("ci_started", "a", 200, "web")];
		const unknown = pipe([...base, ci("ci_finished", "u", 30 * 60_000, "web")]);
		expect(unknown.steps.ci).toMatchObject({ status: "unknown", durationMs: null });
		expect(unknown.ci).toEqual({ total: 1, running: 0, failed: 0 });
		expect(unknown.ciStaleAt).toBeNull();
		// The real outcome, read after the machine gave up, wins either way round.
		const known = pipe([...base, ci("ci_finished", "c", 5_000, "web", { flag: true, number: 4_800 }), ci("ci_finished", "u", 30 * 60_000, "web")]);
		expect(known.steps.ci.status).toBe("ok");
		const later = pipe([...base, ci("ci_finished", "u", 30 * 60_000, "web"), ci("ci_finished", "c", 31 * 60_000, "web", { flag: false, number: 4_800 })]);
		expect(later.steps.ci.status).toBe("err");
		// One unknown workflow beside a passed one: the step is unknown; beside a failed one, failed.
		const two = [...base, ci("ci_started", "b", 210, "agent"), ci("ci_finished", "c", 5_000, "agent", { flag: true, number: 4_000 }), ci("ci_finished", "u", 30 * 60_000, "web")];
		expect(pipe(two).steps.ci.status).toBe("unknown");
	});

	it("ages a CI run with no outcome CI_STALE_MS after it started into unknown, by the machine's now", () => {
		const { state } = played([prompt(1, 0), git("p", 10, 2, { ok: true, took: 100 }), ci("ci_started", "a", 200, "web")]);
		const started = state.log.find((e) => e.id === "event:a")?.at ?? 0;
		const fresh = pipelineOf(state.log, started + CI_STALE_MS - 1);
		expect(fresh.steps.ci.status).toBe("run");
		expect(fresh.ciStaleAt).toBe(started + CI_STALE_MS);
		expect(pipelineAt(fresh, state.log, started + CI_STALE_MS - 1)).toBe(fresh);
		const stale = pipelineAt(fresh, state.log, started + CI_STALE_MS);
		expect(stale.steps.ci.status).toBe("unknown");
		expect(stale.ciStaleAt).toBeNull();
		// Without a now (the look's own), nothing ages.
		expect(pipelineOf(state.log).steps.ci.status).toBe("run");
	});

	it("takes a ci_finished without its start (the watch began late) at its duration", () => {
		const p = pipe([prompt(1, 0), git("p", 10, 2, { ok: true, took: 100 }), ci("ci_finished", "c", 9_000, "web", { flag: true, number: 3_000 })]);
		expect(p.steps.ci).toMatchObject({ status: "ok", durationMs: 3_000 });
	});

	it("resets the later steps on a new commit", () => {
		const p = pipe([
			prompt(1, 0),
			git("c1", 10, 1, { ok: true, took: 100 }),
			git("p1", 200, 2, { ok: true, took: 100 }),
			ci("ci_finished", "c", 900, "web", { flag: false, number: 500 }),
			git("d1", 1_000, 4, { ok: true, took: 100 }),
			prompt(2, 2_000),
			git("c2", 2_100, 1),
		]);
		expect(p.steps.commit).toMatchObject({ status: "run", eventId: "tool:c2" });
		expect([p.steps.push.status, p.steps.ci.status, p.steps.deploy.status]).toEqual(["idle", "idle", "idle"]);
		expect(p.prod).toBe(false);
	});

	it("a call that both commits and pushes fills both steps; a failed push is an error", () => {
		const p = pipe([prompt(1, 0), git("cp", 10, 1 | 2, { ok: false, took: 900 })]);
		expect(p.steps.commit.status).toBe("err");
		expect(p.steps.push.status).toBe("err");
	});
});
