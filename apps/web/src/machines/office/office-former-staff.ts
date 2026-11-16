// Employees that had left the office before this device opened it (a page
// reload): the snapshot lists them (OfficeState.residents, an agent that
// sends it), and the store hires them back in the order everyone came in,
// each free from when they finished or left, then sends those gone off duty.
// The office's own hiring (office-staff.ts) then gives everyone the same key,
// name and number a device watching all along gave them. An older agent
// sends none: only the actors are hired, as before.
import type { OfficeResident } from "@achoo254/chat-proto/remote/remote";
import type { ActorRecord } from "./office-state.ts";

/** An employee no longer in the office, as the store hires it again. */
export interface FormerStaff {
	readonly id: string;
	readonly role: "employee";
	readonly agentType: string;
	readonly parentId: string;
	readonly spawnDepth: number;
	/** Machine times. */
	readonly enteredAt: number;
	/** From when another subagent of the type may take their place: when they finished, else when they left. */
	readonly freeFrom: number;
	readonly leftAt: number;
}

export function formerStaffOf(list: readonly OfficeResident[]): FormerStaff[] {
	return list
		.filter((r) => r.id !== "" && r.id !== "director")
		.map((r) => {
			const doneAt = Number(r.doneAt);
			const leftAt = Number(r.leftAt);
			return {
				id: r.id,
				role: "employee",
				agentType: r.agentType,
				parentId: r.parentId,
				spawnDepth: r.spawnDepth,
				enteredAt: Number(r.enteredAt),
				freeFrom: doneAt > 0 ? Math.min(doneAt, leftAt) : leftAt,
				leftAt,
			};
		});
}

type Hireable = Pick<ActorRecord, "id" | "role" | "agentType" | "spawnDepth" | "parentId" | "enteredAt">;

/**
 * Who to hire, in the order they came in: the former staff and the
 * snapshot's actors merged by entry time (an actor before a former employee
 * of the same time, each list keeping its own order).
 */
export function hireOrder(former: readonly FormerStaff[], actors: readonly Hireable[]): Hireable[] {
	const tagged = [...actors.map((a, i) => ({ a, rank: 0, i })), ...former.map((a, i) => ({ a, rank: 1, i }))];
	return tagged.sort((x, y) => x.a.enteredAt - y.a.enteredAt || x.rank - y.rank || x.i - y.i).map((t) => t.a);
}
