// What the office calls people and what their speech bubbles say, shared by
// the 2D and 3D views. Bubbles show the real tool at once (the agent already
// cut the subject down to a file name, a command's first word or a domain).
// A background service from an agent that labels it is named by what it runs
// ("Máy chủ dev") and says its port and how long it has run; an older agent's
// machine stays "Máy Bash".
import type { MachinesCopy } from "../copy-vi.ts";
import { castOf, nameFromType, ROLE_COLORS, SERVICE_COLORS } from "./office-cast.ts";
import type { Placement } from "./office-placement.ts";
import type { ActivityView, ActorView } from "./office-store.ts";
import type { ServiceView } from "./office-state.ts";

export type OfficeCopy = MachinesCopy["office"];

export function personName(t: OfficeCopy, p: Pick<Placement, "kind" | "actor" | "member">): string {
	switch (p.kind) {
		case "director":
			return t.director;
		case "chairman":
			return t.chairman;
		case "machine": {
			const service = p.actor?.service ?? null;
			return service === null ? t.machine(p.actor?.agentType ?? "") : t.service.names[service.kind];
		}
		case "employee": {
			const type = p.member?.agentType ?? p.actor?.agentType ?? "";
			const key = castOf(type).key;
			const base = key === null ? nameFromType(type) || t.unnamed : t.cast[key];
			const ordinal = p.member?.ordinal ?? 1;
			return ordinal > 1 ? t.numbered(base, ordinal) : base;
		}
	}
}

export function personColor(p: Pick<Placement, "kind" | "actor" | "member">): string {
	if (p.kind === "director") return ROLE_COLORS.director;
	if (p.kind === "chairman") return ROLE_COLORS.chairman;
	if (p.kind === "machine") return SERVICE_COLORS[p.actor?.service?.kind ?? "script"];
	return castOf(p.member?.agentType ?? p.actor?.agentType ?? "").color;
}

/** The speech bubble of work: "Read · agent-core.ts", "Bash · git", what a non-tool activity is, or a snore over a stuck tool. */
export function bubbleText(t: OfficeCopy, activity: ActivityView | null): string {
	if (activity === null) return "";
	if (activity.stuckMs !== null) return t.snore;
	if (activity.tool === "") {
		if (activity.group === "arrive") return t.doing.arrive;
		if (activity.group === "hand-in") return t.doing.handIn;
		return activity.group === "think" ? t.doing.think : "";
	}
	// An MCP tool comes as "mcp" with the tool's own name as its subject: "mcp · create_issue".
	return activity.subject === "" ? activity.tool : `${activity.tool} · ${activity.subject}`;
}

/** A service's bubble: "Máy chủ dev · cổng 5173 · 12 phút" (the port only when known). */
export function serviceBubble(t: OfficeCopy, service: ServiceView): string {
	const parts = [t.service.names[service.kind]];
	if (service.port !== null) parts.push(t.service.port(service.port));
	parts.push(t.service.uptime(Math.floor(service.uptimeMs / 60_000)));
	return parts.join(" · ");
}

/** The bubble of a person at work: a labelled service says what it is (unless it dozes), anyone else their tool. */
function workBubble(t: OfficeCopy, actor: ActorView | null): string {
	const activity = actor?.activity ?? null;
	const service = actor?.service ?? null;
	if (service !== null && activity !== null && activity.stuckMs === null) return serviceBubble(t, service);
	return bubbleText(t, activity);
}

export type MarkerStatus = "idle" | "working" | "done" | "awaiting" | "slow" | "stuck" | "denied" | "waiting-you";

/** The status dot of a person (an off-duty resident without an actor is idle). */
export function markerStatus(kind: Placement["kind"], actor: ActorView | null): MarkerStatus {
	if (kind === "chairman") return "waiting-you";
	if (actor === null) return "idle";
	if (actor.state === "awaiting") return "awaiting";
	const approval = actor.approval;
	if (approval?.state === "denied" && actor.state === "working" && (actor.activity === null || actor.activity.startedAt <= approval.at)) return "denied";
	if (actor.activity?.stuckMs != null) return "stuck";
	if (actor.activity?.slow === true) return "slow";
	if (actor.state === "done") return "done";
	if (actor.activity !== null || actor.state === "working") return "working";
	return "idle";
}

/** What a person's marker shows (2D) or their pin over the scene (3D): the same in both. */
export interface MarkerView {
	readonly status: MarkerStatus;
	readonly name: string;
	/** The name and, when it says more, the state: "Bé Kiểm Thử · Kẹt 6 phút", "Giám đốc · Đang ngủ". */
	readonly label: string;
	/** The bubble's text ("" for none): a line of a conversation, else the work. */
	readonly bubble: string;
	/** The bubble is a line of a conversation. */
	readonly talking: boolean;
}

/** `line`: what the person says in a conversation now, or null. */
export function markerView(t: OfficeCopy, p: Placement, line: string | null): MarkerView {
	const status = markerStatus(p.kind, p.actor);
	const name = personName(t, p);
	const activity = p.actor?.activity ?? null;
	let state: string | null = null;
	if (status === "stuck") state = t.stuck(Math.floor((activity?.stuckMs ?? 0) / 60_000));
	else if (status === "waiting-you") state = t.state.waitingYou;
	// Off duty on the living floor, what they do says more than "done".
	else if (p.life !== null && p.activityRoom === null && (status === "idle" || status === "done")) state = t.life[p.life.act];
	else if (status !== "idle" && status !== "working") state = t.state[status];
	const label = state === null ? name : `${name} · ${state}`;
	// A work bubble only while at work (not for someone home after handing in their file).
	const work = p.activityRoom === null ? "" : workBubble(t, p.actor);
	if (line !== null && work === "") return { status, name, label, bubble: line, talking: true };
	return { status, name, label, bubble: work, talking: false };
}
