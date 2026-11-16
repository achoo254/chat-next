// Employees that left a session's office, kept so a device that opens the
// office later (a page reload) still knows everyone who worked in it and
// names them as a device watching all along did (OfficeState.residents,
// docs/office-wire.md part 3). Only what the employee's OfficeActor already
// carried: its id, agent type, nesting and times. Bounded: the last
// MAX_RESIDENTS to leave.
import { create } from "@bufbuild/protobuf";
import { type OfficeResident, OfficeResidentSchema } from "@achoo254/chat-proto/remote/remote";
import type { ActorRecord } from "./office-actor.ts";

/** Employees that left, kept at most (the oldest to leave is forgotten first). */
export const MAX_RESIDENTS = 32;

type Resident = { id: string; agentType: string; parentId: string; spawnDepth: number; enteredAt: number; doneAt: number; leftAt: number };

export class ResidentLog {
  /** In the order they left. */
  private readonly left: Resident[] = [];

  /** An employee left the office at `at`. */
  record(a: ActorRecord, at: number): void {
    const i = this.left.findIndex((r) => r.id === a.id);
    if (i >= 0) this.left.splice(i, 1);
    this.left.push({ id: a.id, agentType: a.agentType, parentId: a.parentId, spawnDepth: a.spawnDepth, enteredAt: a.enteredAt, doneAt: a.doneAt, leftAt: at });
    if (this.left.length > MAX_RESIDENTS) this.left.splice(0, this.left.length - MAX_RESIDENTS);
  }

  /** The snapshot's list: in the order they came in (ties by id, so it is the same every time). */
  wire(): OfficeResident[] {
    return [...this.left]
      .sort((a, b) => a.enteredAt - b.enteredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) =>
        create(OfficeResidentSchema, {
          id: r.id,
          agentType: r.agentType,
          parentId: r.parentId,
          spawnDepth: r.spawnDepth,
          enteredAt: BigInt(r.enteredAt),
          doneAt: BigInt(r.doneAt),
          leftAt: BigInt(r.leftAt),
        }),
      );
  }
}
