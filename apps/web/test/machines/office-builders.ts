// Builders of office frames for the office tests (docs/office-wire.md).
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
	OfficeActivitySchema,
	OfficeActorSchema,
	OfficeActorState,
	OfficeAnimGroup,
	OfficeEventSchema,
	OfficeResidentSchema,
	OfficeRole,
	OfficeRoom,
	OfficeServiceSchema,
	OfficeSessionSchema,
	OfficeSnapshotSchema,
	type OfficeActivity,
	type OfficeActor,
	type OfficeEvent,
	type OfficeResident,
	type OfficeSession,
	type OfficeSnapshot,
} from "@achoo254/chat-proto/remote/remote";
import { createOfficeStore, type OfficeStore } from "../../src/machines/office/office-store.ts";

/** 15:00 on the viewer's clock whatever the time zone: office hours, so off-duty people stay on the work floors (office-life-schedule.ts). */
export const T0 = new Date(2027, 0, 15, 15, 0).getTime();

/** A viewer time at a local hour and minute of T0's day. */
export function localAt(hour: number, minute = 0): number {
	return new Date(2027, 0, 15, hour, minute).getTime();
}

export function act(id: string, room: OfficeRoom, tool = "Read", startedAt = T0, group = OfficeAnimGroup.READ): OfficeActivity {
	return create(OfficeActivitySchema, { id, tool, group, room, startedAt: BigInt(startedAt) });
}

export function director(extra: Partial<Pick<OfficeActor, "state" | "activity">> = {}): OfficeActor {
	return create(OfficeActorSchema, { id: "director", role: OfficeRole.DIRECTOR, state: OfficeActorState.WORKING, enteredAt: BigInt(T0), ...extra });
}

export function staff(id: string, agentType: string, extra: Partial<Pick<OfficeActor, "state" | "activity" | "doneAt" | "spawnDepth" | "parentId" | "enteredAt">> = {}): OfficeActor {
	return create(OfficeActorSchema, { id, role: OfficeRole.EMPLOYEE, agentType, spawnDepth: 1, state: OfficeActorState.WORKING, enteredAt: BigInt(T0), ...extra });
}

export function machine(id: string, room = OfficeRoom.SERVER, service?: MessageInitShape<typeof OfficeServiceSchema>): OfficeActor {
	return create(OfficeActorSchema, {
		id,
		role: OfficeRole.MACHINE,
		agentType: "Bash",
		state: OfficeActorState.WORKING,
		enteredAt: BigInt(T0),
		activity: act(id, room, "Bash", T0, OfficeAnimGroup.MACHINE),
		...(service === undefined ? {} : { service: create(OfficeServiceSchema, service) }),
	});
}

/** An employee that left before the snapshot (OfficeState.residents). */
export function resident(id: string, agentType: string, times: { enteredAt: number; doneAt?: number; leftAt: number }, nesting: { parentId?: string; spawnDepth?: number } = {}): OfficeResident {
	return create(OfficeResidentSchema, {
		id,
		agentType,
		parentId: nesting.parentId ?? "",
		spawnDepth: nesting.spawnDepth ?? 1,
		enteredAt: BigInt(times.enteredAt),
		doneAt: BigInt(times.doneAt ?? 0),
		leftAt: BigInt(times.leftAt),
	});
}

export function session(extra: Partial<Omit<OfficeSession, "$typeName" | "$unknown">> = {}): OfficeSession {
	return create(OfficeSessionSchema, { busy: true, startedAt: BigInt(T0), ...extra });
}

export function snapshot(actors: OfficeActor[], options: { epoch?: bigint; seq?: bigint; reportsStaff?: boolean; session?: OfficeSession; residents?: OfficeResident[] } = {}): OfficeSnapshot {
	return create(OfficeSnapshotSchema, {
		threadId: "t1",
		epoch: options.epoch ?? 1n,
		seq: options.seq ?? 0n,
		state: { actors, reportsStaff: options.reportsStaff ?? true, session: options.session ?? session(), residents: options.residents ?? [] },
	});
}

export function ev(seq: number, kind: NonNullable<MessageInitShape<typeof OfficeEventSchema>["kind"]>, at = T0 + seq * 1000): OfficeEvent {
	return create(OfficeEventSchema, { seq: BigInt(seq), at: BigInt(at), kind });
}

/** A store on a hand-driven clock. */
export function storeAt(start = T0, desks?: readonly string[]): { store: OfficeStore; clock: { now: number } } {
	const clock = { now: start };
	const store = createOfficeStore({ now: () => clock.now, ...(desks === undefined ? {} : { desks }) });
	return { store, clock };
}
