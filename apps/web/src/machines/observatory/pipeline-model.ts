// The Git · CI/CD pipeline of the Live Map: commit → push → CI → deploy →
// prod, worked out from the session's events (pure). A step comes from a
// tool call's `station_flags` (commit 1, push 2, deploy 4, ci 128: a shell
// call that follows CI, `gh run watch`, `gh pr checks`) and, for CI, also
// from the lifecycle events the agent sends while it follows GitHub Actions
// after a push (`ci_started` / `ci_finished`: label = the workflow's name,
// flag = success, number = duration ms). A `ci_finished` without a flag is an
// outcome the machine does not know (it stopped following the run), and a run
// with no `ci_finished` CI_STALE_MS after it started is taken as unknown too
// (the agent restarted meanwhile): neither ✓ nor ✗. An unknown outcome never
// replaces a known one of the same workflow. Several workflows fold into one
// CI step: running while one still runs, failed when one failed, unknown when
// one is, with their count. A new commit resets the steps after it.
//
// A run GitHub cancelled (`ci_cancelled`: usually a newer push replaced it) is
// neither a pass nor a failure: it reads "cancelled" when it is all there is,
// and never takes the place of a run of the same workflow that started later.
//
// Which events: the turn of the latest release call (from the prompt before
// it), and the CI lifecycle events after that prompt even when they land in
// a later turn (CI ends after Claude's turn often). A session with no release
// call shows the CI it was told about, if any.
import { RELEASE_STEPS, stepsOf, type ReleaseStep } from "./call-history.ts";
import type { LiveMapEvent } from "./live-map-types.ts";

export const CI_STARTED = "ci_started";
export const CI_FINISHED = "ci_finished";
export const CI_CANCELLED = "ci_cancelled";

export type StepStatus = "idle" | "run" | "ok" | "err" | "unknown" | "cancelled";

/** A CI run with no outcome this long after it started reads as unknown. */
export const CI_STALE_MS = 45 * 60_000;

export interface PipelineStep {
	readonly status: StepStatus;
	/** When it started (machine ms); null when idle. */
	readonly startedAt: number | null;
	/** How long it took once ended. */
	readonly durationMs: number | null;
	/** The event behind it (the newest), null when idle or from the CI lifecycle only. */
	readonly eventId: string | null;
}

export interface CiWorkflows {
	readonly total: number;
	readonly running: number;
	readonly failed: number;
}

export interface Pipeline {
	readonly steps: Readonly<Record<ReleaseStep, PipelineStep>>;
	/** Workflows followed after a push (none: the CI step is a `gh` call of Claude's, or nothing). */
	readonly ci: CiWorkflows;
	/** A deploy succeeded. */
	readonly prod: boolean;
	/** When the oldest CI run still running turns unknown (machine ms); null when none runs. */
	readonly ciStaleAt: number | null;
}

const IDLE: PipelineStep = { status: "idle", startedAt: null, durationMs: null, eventId: null };

interface Entry {
	status: Exclude<StepStatus, "idle">;
	startedAt: number;
	durationMs: number | null;
	eventId: string | null;
}

function isCi(e: LiveMapEvent): e is Extract<LiveMapEvent, { kind: "lifecycle" }> {
	return e.kind === "lifecycle" && (e.name === CI_STARTED || e.name === CI_FINISHED || e.name === CI_CANCELLED);
}

function releaseSteps(e: LiveMapEvent): ReleaseStep[] {
	return e.kind === "tool" ? stepsOf(e.stationFlags) : [];
}

/** The events the pipeline is read from (see the file's header). */
function scope(log: readonly LiveMapEvent[]): readonly LiveMapEvent[] {
	let anchor = -1;
	for (let i = log.length - 1; i >= 0; i--) {
		const e = log[i];
		if (e !== undefined && releaseSteps(e).length > 0) {
			anchor = i;
			break;
		}
	}
	if (anchor < 0) return log.filter(isCi);
	let start = 0;
	for (let i = anchor; i >= 0; i--) {
		if (log[i]?.kind === "prompt") {
			start = i;
			break;
		}
	}
	return log.slice(start).filter((e, i) => isCi(e) || start + i <= anchor);
}

/**
 * The pipeline of a session's ordered log; with `now` (machine ms), the CI
 * runs older than CI_STALE_MS that still run are unknown.
 */
export function pipelineOf(log: readonly LiveMapEvent[], now?: number): Pipeline {
	const tools = new Map<ReleaseStep, Map<string, Entry>>(RELEASE_STEPS.map((s) => [s, new Map()]));
	const workflows = new Map<string, Entry>();
	const reset = (from: number): void => {
		for (const s of RELEASE_STEPS.slice(from)) tools.get(s)?.clear();
		if (from <= RELEASE_STEPS.indexOf("ci")) workflows.clear();
	};
	for (const e of scope(log)) {
		if (e.kind === "tool") {
			const steps = stepsOf(e.stationFlags);
			// A new commit starts a new release: the steps of the one before go.
			if (steps.includes("commit")) reset(0);
			for (const step of steps) {
				const entry: Entry = {
					status: e.success === undefined ? "run" : e.success ? "ok" : "err",
					startedAt: e.at,
					durationMs: e.durationMs ?? null,
					eventId: e.id,
				};
				tools.get(step)?.set(e.toolUseId, entry);
			}
		} else if (isCi(e)) {
			const name = e.label === "" ? "CI" : e.label;
			const current = workflows.get(name);
			if (e.name === CI_STARTED) workflows.set(name, { status: "run", startedAt: e.at, durationMs: null, eventId: null });
			else if (e.name === CI_CANCELLED) {
				// The run's own start is its end less its duration (both are GitHub's times, as in `ci_started`); a workflow that started a newer run keeps that one.
				const startedAt = e.number === undefined ? e.at : e.at - e.number;
				if (current === undefined || current.startedAt <= startedAt) workflows.set(name, { status: "cancelled", startedAt, durationMs: e.number ?? null, eventId: null });
			} else if (e.flag === undefined) {
				// The machine stopped following the run: unknown, unless its outcome is known already.
				if (current?.status !== "ok" && current?.status !== "err") workflows.set(name, { status: "unknown", startedAt: current?.startedAt ?? e.at, durationMs: null, eventId: null });
			} else {
				const durationMs = e.number ?? null;
				const startedAt = current?.startedAt ?? (durationMs === null ? e.at : e.at - durationMs);
				workflows.set(name, { status: e.flag ? "ok" : "err", startedAt, durationMs, eventId: null });
			}
		}
	}
	let ciStaleAt: number | null = null;
	for (const [name, w] of workflows) {
		if (w.status !== "run") continue;
		if (now !== undefined && now >= w.startedAt + CI_STALE_MS) workflows.set(name, { ...w, status: "unknown" });
		else ciStaleAt = Math.min(ciStaleAt ?? Infinity, w.startedAt + CI_STALE_MS);
	}
	const steps = {} as Record<ReleaseStep, PipelineStep>;
	for (const step of RELEASE_STEPS) {
		const entries = [...(tools.get(step)?.values() ?? [])];
		if (step === "ci") entries.push(...workflows.values());
		steps[step] = fold(entries);
	}
	const flows = [...workflows.values()];
	return {
		steps,
		ci: { total: flows.length, running: flows.filter((w) => w.status === "run").length, failed: flows.filter((w) => w.status === "err").length },
		prod: steps.deploy.status === "ok",
		ciStaleAt,
	};
}

/** `pipeline` (of `log`) as it reads at `now` (machine ms): itself until a CI run turns stale, then worked out again. */
export function pipelineAt(pipeline: Pipeline, log: readonly LiveMapEvent[], now: number): Pipeline {
	return pipeline.ciStaleAt !== null && now >= pipeline.ciStaleAt ? pipelineOf(log, now) : pipeline;
}

/** Several runs of one step as one: running while one runs, failed when one failed, unknown when one is, else done. */
function fold(entries: readonly Entry[]): PipelineStep {
	if (entries.length === 0) return IDLE;
	const has = (status: Entry["status"]): boolean => entries.some((e) => e.status === status);
	const status: StepStatus = has("run") ? "run" : has("err") ? "err" : has("unknown") ? "unknown" : has("ok") ? "ok" : "cancelled";
	const startedAt = Math.min(...entries.map((e) => e.startedAt));
	const ends = entries.map((e) => (e.durationMs === null ? null : e.startedAt + e.durationMs));
	const durationMs = status === "run" || ends.some((x) => x === null) ? null : Math.max(...ends.map((x) => x ?? 0)) - startedAt;
	const newest = [...entries].reverse().find((e) => e.eventId !== null);
	return { status, startedAt, durationMs, eventId: newest?.eventId ?? null };
}
