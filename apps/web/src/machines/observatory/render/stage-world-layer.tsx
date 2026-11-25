// The Live Map's DOM in the scene's own coordinates (scene pixels), inside
// the world layer the camera moves (live-map-stage.tsx sets its transform
// from the renderer's view): an invisible button over each district (Tab
// reaches it, Enter or a click selects it), a name tag at each district's
// anchor (kept at one screen size whatever the zoom), the roads' figures
// (`runtime` while a call runs, else calls and the session's p95, never
// mixed), the release pipeline's step names and times on the Git district,
// and the holographic board over the district in view with its live content.
// "Ẩn chi tiết" hides every name the privacy filter kept (files, commands,
// domains, MCP tools through drill-format.ts toolName, the account's email).
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { RELEASE_STEPS } from "../call-history.ts";
import type { MachinesCopy } from "../../copy-vi.ts";
import { districtBoardOf, type BoardRow } from "../district-board-model.ts";
import { duration, toolName } from "../drill-format.ts";
import { coreOf, type LiveMapState } from "../live-map-state.ts";
import type { LiveMapEvent } from "../live-map-types.ts";
import type { ObservatoryCopy } from "../observatory-copy.ts";
import { pipelineAt, type Pipeline } from "../pipeline-model.ts";
import { stationAtPlace } from "../place-names.ts";
import { useToolContent, type ContentSource } from "../use-tool-content.ts";
import { holoPanelRect, lookOf, pipelineSlots, type RoadLook } from "./prop-map.ts";
import { PLACE_IDS, type PlaceId, type Point, type Rect, type SceneTable } from "./scene-table.ts";

const SHORT_MODEL = /^claude-([a-z]+)/;

export interface WorldLayerProps {
	readonly scene: SceneTable;
	readonly state: LiveMapState;
	/** The machine's clock now (or the replayed moment). */
	readonly now: number;
	readonly names: Readonly<Record<PlaceId, string>>;
	readonly observe: MachinesCopy["observe"];
	readonly c: ObservatoryCopy;
	readonly accountEmail: string;
	readonly hide: boolean;
	readonly selectedPlace: PlaceId | null;
	/** The district whose board shows (null: none). */
	readonly contentZone: PlaceId | null;
	readonly source: ContentSource | null;
	/** Batches playing at a place (×n). */
	readonly batches: Partial<Record<PlaceId, number>>;
}

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

/** How a tag sits on its anchor: centred when the anchor is near the district's middle, else from its left. */
function tagAlign(scene: SceneTable, place: PlaceId): "centre" | "left" {
	const r = scene.places[place].rect;
	const [x] = scene.places[place].label;
	return Math.abs(x - (r.x + r.w / 2)) < r.w * 0.08 ? "centre" : "left";
}

/** The middle of a road's longest leg: where its figures sit. */
function roadMiddle(path: readonly Point[]): Point {
	let best: Point = path[0] ?? [0, 0];
	let longest = -1;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] ?? best;
		const b = path[i] ?? a;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (len > longest) {
			longest = len;
			best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		}
	}
	return best;
}

interface Tag {
	readonly place: PlaceId;
	readonly facts: readonly string[];
	/** A name the filter kept (hidden by "Ẩn chi tiết"). */
	readonly detail: string;
	/** The tool at work there now (null: none), how many more run there, and its target. */
	readonly working: { readonly tool: string; readonly mcpServer: string } | null;
	/** Calls running there: more than one adds "+n". */
	readonly runningCount: number;
	readonly workingTarget: string;
	readonly bottleneck: "none" | "warn" | "alert";
}

function tagsOf(state: LiveMapState, observe: MachinesCopy["observe"], accountEmail: string): Tag[] {
	const t = observe.map;
	const byId = new Map<string, LiveMapEvent>();
	let prompts = 0;
	for (const e of state.log) {
		byId.set(e.id, e);
		if (e.kind === "prompt") prompts += 1;
	}
	const s = state.scene;
	const core = state.live?.core ?? coreOf(state);
	const model = SHORT_MODEL.exec(state.live?.mainModel || s.model)?.[1] ?? (state.live?.mainModel || s.model);
	const percent = state.live?.contextPercent ?? null;
	const waiting = Object.values(s.stations).reduce((n, st) => n + st.queued, 0);
	return PLACE_IDS.map((place): Tag => {
		const station = stationAtPlace(place);
		if (station === null) {
			const none = { working: null, runningCount: 0, workingTarget: "", bottleneck: "none" } as const;
			if (place === "user-desk") return { place, facts: prompts > 0 ? [t.prompt(prompts)] : [], detail: accountEmail, ...none };
			if (place === "security") return { place, facts: waiting > 0 ? [t.waiting(waiting)] : [], detail: "", ...none };
			const assumed = state.live?.contextWindowAssumed === true;
			return { place, facts: percent === null ? [] : [assumed ? t.contextApprox(Math.round(percent)) : t.context(Math.round(percent))], detail: "", ...none };
		}
		const st = s.stations[station];
		const facts: string[] = [];
		if (station === "CORE") facts.push(...[model, t.core[core]].filter((x) => x !== ""));
		if (st.calls > 0) facts.push(t.calls(st.calls, st.failures));
		if (station === "ORCHESTRATOR") {
			const running = Object.values(s.subagents).filter((x) => x.running).length;
			if (running > 0) facts.push(t.subagents(running));
			if (s.todo !== null) facts.push(t.todo(s.todo.pending, s.todo.inProgress, s.todo.done));
		}
		if (station === "SANDBOX" && s.backgroundShells.size > 0) facts.push(t.shells(s.backgroundShells.size));
		const last = st.last === null ? undefined : byId.get(st.last);
		const first = st.running.length === 0 ? undefined : byId.get(st.running[0] ?? "");
		const working = first?.kind === "tool" ? { tool: first.toolName, mcpServer: first.mcpServer } : null;
		return { place, facts, detail: last?.kind === "tool" ? last.target : "", working, runningCount: st.running.length, workingTarget: first?.kind === "tool" ? first.target : "", bottleneck: st.bottleneck };
	});
}

/** A tag's "at work" line ("" when nothing runs there): the tool (hidden details: no MCP name, no target), "+n" for more. */
function workingText(c: ObservatoryCopy, tag: Tag, hide: boolean): string {
	if (tag.working === null) return tag.runningCount > 0 ? `+${tag.runningCount}` : "";
	const more = tag.runningCount > 1 ? ` +${tag.runningCount - 1}` : "";
	const tool = `${toolName(c, tag.working.tool, tag.working.mcpServer, hide)}${more}`;
	return !hide && tag.workingTarget !== "" ? `${tool} · ${tag.workingTarget}` : tool;
}

/** Who made a board row's call: "" for the main agent. */
function agentPrefix(c: ObservatoryCopy, agent: string | null): string {
	if (agent === null) return "";
	return `${agent === "" ? c.card.subagentUnknown : agent} › `;
}

function rowText(c: ObservatoryCopy, r: BoardRow, hide: boolean): string {
	const tool = toolName(c, r.tool, r.mcpServer, hide);
	return `${r.running ? "▶ " : ""}${agentPrefix(c, r.agent)}${hide || r.target === "" ? tool : `${tool} ${r.target}`}`;
}

function roadFigures(c: ObservatoryCopy, road: RoadLook, now: number): string {
	const first = road.running[0];
	if (first !== undefined) return c.board.runtime(duration(c, Math.max(0, now - first.startedAt)));
	const parts = [c.board.calls(road.calls)];
	if (road.p95Ms !== null) parts.push(c.board.p95(duration(c, road.p95Ms)));
	if (road.failures > 0) parts.push(c.board.failures(road.failures));
	return parts.join(" · ");
}

/** The newest ended call's result line on a board (content: asked by id like the card). */
function BoardResult({ c, source, eventId, hide }: { c: ObservatoryCopy; source: ContentSource | null; eventId: string; hide: boolean }) {
	const answer = useToolContent(source, eventId, true, hide);
	if (answer.kind !== "ok" || answer.content.outputLine === "") return null;
	return (
		<p className="lm-board-result" data-id="observe-board-result">
			{c.board.result}: {answer.content.outputLine}
		</p>
	);
}

function Board({ props, place }: { props: WorldLayerProps; place: PlaceId }) {
	const { c, scene, state, now, hide } = props;
	const board = districtBoardOf(state, place, now);
	const r = holoPanelRect(scene, place);
	let body: ReactNode;
	switch (board.kind) {
		case "calls":
			body = (
				<>
					{board.rows.length === 0 ? <p className="lm-board-muted">{c.board.empty}</p> : null}
					<ul>
						{board.rows.map((row) => (
							<li key={row.eventId} data-running={row.running || undefined} data-failed={row.ok === false || undefined}>
								<span>{rowText(c, row, hide)}</span>
								<b>{row.ok === false ? `✗ ${duration(c, row.runtimeMs)}` : duration(c, row.runtimeMs)}</b>
							</li>
						))}
					</ul>
					{board.lastEnded !== null && <BoardResult c={c} source={props.source} eventId={board.lastEnded} hide={hide} />}
				</>
			);
			break;
		case "model":
			body = (
				<ul>
					<li>
						<span>{board.model}</span>
						<b>{c.board.apiTurn(board.apiTurns)}</b>
					</li>
					{board.contextPercent !== null && (
						<li>
							<span>{c.board.context(Math.round(board.contextPercent))}</span>
							<b>{board.tokensPerSecond === null ? "" : c.board.speed(Math.round(board.tokensPerSecond))}</b>
						</li>
					)}
				</ul>
			);
			break;
		case "subagents":
			body =
				board.running.length === 0 ? (
					<p className="lm-board-muted">{c.board.noSubagent}</p>
				) : (
					<ul>
						{board.running.map((type, i) => (
							<li key={`${i}-${type}`} data-running>
								<span>▶ {type === "" ? c.card.subagentUnknown : type}</span>
								<b>{c.board.subagentRunning}</b>
							</li>
						))}
					</ul>
				);
			break;
		case "context":
			body = <p>{board.percent === null ? "–" : c.board.context(Math.round(board.percent))}</p>;
			break;
		case "permission":
			body = <p className="lm-board-muted">{board.waiting ? c.board.waitingFor(hide ? "" : board.what) : "–"}</p>;
			break;
		case "prompts":
			body = <p>{c.board.prompts(board.count)}</p>;
			break;
	}
	return (
		<section className="lm-board" style={box(r)} aria-label={c.board.label(props.names[place])} data-id={`observe-board-${place}`} data-place-board={place} data-station={stationAtPlace(place) ?? undefined}>
			<h4>{props.names[place]}</h4>
			{body}
		</section>
	);
}

function PipelineLabels({ c, scene, pipeline, now }: { c: ObservatoryCopy; scene: SceneTable; pipeline: Pipeline; now: number }) {
	const { steps, prod } = pipelineSlots(scene);
	return (
		<>
			{RELEASE_STEPS.map((step, i) => {
				const slot = steps[i];
				if (slot === undefined) return null;
				const st = pipeline.steps[step];
				const time = st.status === "run" && st.startedAt !== null ? duration(c, Math.max(0, now - st.startedAt)) : st.durationMs !== null ? duration(c, st.durationMs) : "";
				const mark = st.status === "ok" ? "✓ " : st.status === "err" ? "✗ " : st.status === "unknown" ? `${c.board.ciUnknown} ` : "";
				const flows = step === "ci" && pipeline.ci.total > 1 ? ` · ${c.board.workflows(pipeline.ci.total)}` : "";
				return (
					<div key={step} className="lm-pipe-step" style={box(slot)} data-id={`observe-pipe-${step}`} data-status={st.status}>
						<b>{c.card.steps[step]}</b>
						<span>
							{mark}
							{time}
							{flows}
						</span>
					</div>
				);
			})}
			<span className="lm-pipe-prod" style={{ left: prod[0], top: prod[1] + 18 }} data-id="observe-pipe-prod" data-on={pipeline.prod || undefined}>
				{c.board.prod}
			</span>
		</>
	);
}

export function WorldLayer(props: WorldLayerProps) {
	const { scene, state, now, names, observe, c, accountEmail, hide, selectedPlace, contentZone, batches } = props;
	const tags = useMemo(() => tagsOf(state, observe, accountEmail), [state, observe, accountEmail]);
	const look = useMemo(() => lookOf(state, scene), [state, scene]);
	// A CI run with no news for too long reads as unknown, by the machine's clock now.
	const pipeline = pipelineAt(look.pipeline, state.log, now);
	const [cx, cy] = scene.core.centre;
	const [rx, ry] = scene.core.orbit;
	return (
		<>
			{PLACE_IDS.map((place) => {
				const r = place === "orchestrator" ? { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 } : scene.places[place].rect;
				return (
					<button
						key={`hit-${place}`}
						type="button"
						className={`lm-hit${place === "orchestrator" ? " is-round" : ""}`}
						data-place={place}
						data-working={look.places[place].active || undefined}
						data-id={`observe-place-${place}`}
						aria-label={names[place]}
						aria-pressed={selectedPlace === place}
						style={box(r)}
					/>
				);
			})}
			{look.roads.map((road) =>
				road.calls === 0 && road.running.length === 0 ? null : (
					<span key={`road-${road.place}`} className="lm-road" style={{ left: roadMiddle(road.path)[0], top: roadMiddle(road.path)[1] }} data-id={`observe-road-${road.place}`} data-running={road.running.length > 0 || undefined} data-station={stationAtPlace(road.place) ?? undefined}>
						{roadFigures(c, road, now)}
					</span>
				),
			)}
			<PipelineLabels c={c} scene={scene} pipeline={pipeline} now={now} />
			{look.tokensPerSecond !== null && (
				<span className="lm-wave-label" style={{ left: scene.wave.x, top: scene.wave.y + scene.wave.h }}>
					{c.board.speed(Math.round(look.mode === "think" ? look.tokensPerSecond : 0))}
				</span>
			)}
			{tags.map((tag) => {
				const [x, y] = scene.places[tag.place].label;
				const cls = ["lm-tag", `is-${tagAlign(scene, tag.place)}`, tag.bottleneck !== "none" ? `is-${tag.bottleneck}` : "", selectedPlace === tag.place ? "is-selected" : "", tag.working !== null || tag.runningCount > 0 ? "is-working" : "", `tier-${scene.places[tag.place].tier}`]
					.filter(Boolean)
					.join(" ");
				const working = workingText(c, tag, hide);
				const batch = batches[tag.place];
				return (
					<div key={`tag-${tag.place}`} className={cls} style={{ left: x, top: y }} data-id={`observe-tag-${tag.place}`} data-station={stationAtPlace(tag.place) ?? undefined} aria-hidden="true">
						<b>
							{tag.bottleneck !== "none" && <span title={observe.map.bottleneck}>⚠ </span>}
							{names[tag.place]}
						</b>
						<i className="lm-tag-sub">{c.places[tag.place]}</i>
						{tag.facts.length > 0 && <i>{tag.facts.join(" · ")}</i>}
						{working !== "" && (
							<i className="lm-working" data-id="observe-working">
								{working}
							</i>
						)}
						{tag.detail !== "" && !hide && working === "" && (
							<i className="lm-detail" data-id="observe-detail">
								{tag.detail}
							</i>
						)}
						{batch !== undefined && <em className="lm-batch">{observe.map.batch(batch)}</em>}
					</div>
				);
			})}
			{contentZone !== null && <Board props={props} place={contentZone} />}
		</>
	);
}
