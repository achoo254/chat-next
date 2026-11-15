// One person or machine of a session's office, as the tracker keeps it, and
// its shape on the wire. Which activity an actor shows: its newest open tool
// call, else what it does between tools (arriving, handing in, thinking).
import { create } from "@bufbuild/protobuf";
import {
  type OfficeActivity,
  OfficeActivitySchema,
  type OfficeActor,
  OfficeActorSchema,
  OfficeActorState,
  OfficeRole,
} from "@achoo254/chat-proto/remote/remote";
import type { OfficePlace } from "./office-activity-map.ts";

export const DIRECTOR_ID = "director";

/** One activity: a tool call (its id), or "think", "arrive", "hand-in". */
export type ActivityRecord = { id: string; tool: string; place: OfficePlace; subject: string; startedAt: number };

export type ActorRecord = {
  id: string;
  role: OfficeRole;
  agentType: string;
  description: string;
  parentId: string;
  spawnDepth: number;
  state: OfficeActorState;
  enteredAt: number;
  doneAt: number;
  /** Runs in the background: its tool call answering is not its end. */
  background: boolean;
  /** Open tool calls, oldest first. */
  open: ActivityRecord[];
  /** What it does when no tool call is open. */
  between?: ActivityRecord;
  /** The activity id devices were last told it shows; "" for none. */
  shownId: string;
  /** Permission prompts waiting on its tools, and its state before the first of them. */
  prompts: number;
  stateBeforePrompt: OfficeActorState;
};

export function newActor(fields: Pick<ActorRecord, "id" | "role" | "enteredAt"> & Partial<ActorRecord>): ActorRecord {
  return {
    agentType: "",
    description: "",
    parentId: "",
    spawnDepth: 0,
    state: OfficeActorState.WORKING,
    doneAt: 0,
    background: false,
    open: [],
    shownId: "",
    prompts: 0,
    stateBeforePrompt: OfficeActorState.WORKING,
    ...fields,
  };
}

/** The activity the actor shows now. */
export function shownActivity(a: ActorRecord): ActivityRecord | undefined {
  return a.open.at(-1) ?? a.between;
}

export function activityWire(r: ActivityRecord): OfficeActivity {
  return create(OfficeActivitySchema, {
    id: r.id,
    tool: r.tool,
    group: r.place.group,
    room: r.place.room,
    subject: r.subject,
    startedAt: BigInt(r.startedAt),
  });
}

export function actorWire(a: ActorRecord): OfficeActor {
  const shown = shownActivity(a);
  return create(OfficeActorSchema, {
    id: a.id,
    role: a.role,
    agentType: a.agentType,
    description: a.description,
    parentId: a.parentId,
    spawnDepth: a.spawnDepth,
    state: a.state,
    ...(shown ? { activity: activityWire(shown) } : {}),
    enteredAt: BigInt(a.enteredAt),
    doneAt: BigInt(a.doneAt),
  });
}

export const isEmployee = (a: ActorRecord): boolean => a.role === OfficeRole.EMPLOYEE;
export const isMachine = (a: ActorRecord): boolean => a.role === OfficeRole.MACHINE;
