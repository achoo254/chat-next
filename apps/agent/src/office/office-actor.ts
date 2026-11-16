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
  OfficeServiceSchema,
} from "@achoo254/chat-proto/remote/remote";
import type { OfficePlace } from "./office-activity-map.ts";
import type { ServiceLabel } from "./office-service-kind.ts";

export const DIRECTOR_ID = "director";
/** Advisor's actor, there while the session's automatic Advisor is on. */
export const ADVISOR_ID = "advisor";

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
  /** Its DONE came from the AI saying its background work ended, or its record saying finished: nothing brings it back. */
  doneInBackground: boolean;
  /** Its DONE was only presumed (silent for long with no tool open): a tool call of its own brings it back to work. */
  donePresumed: boolean;
  /** When the tracker last heard of it (entering, a tool call of its own starting or ending). */
  heardAt: number;
  /** Open tool calls, oldest first. */
  open: ActivityRecord[];
  /** What it does when no tool call is open. */
  between?: ActivityRecord;
  /** The activity id devices were last told it shows; "" for none. */
  shownId: string;
  /** Permission prompts waiting on its tools, and its state before the first of them. */
  prompts: number;
  stateBeforePrompt: OfficeActorState;
  /** A machine's background command as a label (kind, port), and when it started; never the command. */
  service?: ServiceLabel & { startedAt: number };
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
    doneInBackground: false,
    donePresumed: false,
    heardAt: fields.enteredAt,
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
    ...(a.service ? { service: create(OfficeServiceSchema, { kind: a.service.kind, port: a.service.port, startedAt: BigInt(a.service.startedAt) }) } : {}),
  });
}

export const isEmployee = (a: ActorRecord): boolean => a.role === OfficeRole.EMPLOYEE;
export const isMachine = (a: ActorRecord): boolean => a.role === OfficeRole.MACHINE;
export const isAdvisor = (a: ActorRecord): boolean => a.role === OfficeRole.ADVISOR;
