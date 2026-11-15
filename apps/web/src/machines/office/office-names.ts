// What the office calls people and what their speech bubbles say, shared by
// the 2D and 3D views. Bubbles show the real tool at once (the agent already
// cut the subject down to a file name, a command's first word or a domain).
import type { MachinesCopy } from "../copy-vi.ts";
import { castOf, nameFromType, ROLE_COLORS } from "./office-cast.ts";
import type { Placement } from "./office-placement.ts";
import type { ActivityView, ActorView } from "./office-store.ts";

export type OfficeCopy = MachinesCopy["office"];

export function personName(t: OfficeCopy, p: Pick<Placement, "kind" | "actor" | "member">): string {
	switch (p.kind) {
		case "director":
			return t.director;
		case "chairman":
			return t.chairman;
		case "machine":
			return t.machine(p.actor?.agentType ?? "");
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
	if (p.kind === "machine") return ROLE_COLORS.machine;
	return castOf(p.member?.agentType ?? p.actor?.agentType ?? "").color;
}

/** The speech bubble: "Read · agent-core.ts", "Bash · git", or what a non-tool activity is. */
export function bubbleText(t: OfficeCopy, activity: ActivityView | null): string {
	if (activity === null) return "";
	if (activity.tool === "") {
		if (activity.group === "arrive") return t.doing.arrive;
		if (activity.group === "hand-in") return t.doing.handIn;
		return activity.group === "think" ? t.doing.think : "";
	}
	// An MCP tool comes as "mcp" with the tool's own name as its subject: "mcp · create_issue".
	return activity.subject === "" ? activity.tool : `${activity.tool} · ${activity.subject}`;
}

export type MarkerStatus = "idle" | "working" | "done" | "awaiting" | "slow" | "denied" | "waiting-you";

/** The status dot of a person. */
export function markerStatus(kind: Placement["kind"], actor: ActorView | null): MarkerStatus {
	if (kind === "chairman" || actor === null) return "waiting-you";
	if (actor.state === "awaiting") return "awaiting";
	const approval = actor.approval;
	if (approval?.state === "denied" && actor.state === "working" && (actor.activity === null || actor.activity.startedAt <= approval.at)) return "denied";
	if (actor.activity?.slow === true) return "slow";
	if (actor.state === "done") return "done";
	if (actor.activity !== null || actor.state === "working") return "working";
	return "idle";
}
