// The write of one session event (store/schema-v2.ts `session_events`) and
// its dedupe key. A key is the event's kind and the ids that tell it apart,
// per kind (the hook's rules: a tool's event by its tool_use_id; a turn's end
// by its prompt; an event without such an id by its time and what it says),
// so the same event read twice (a spool chunk read again after a crash) is
// stored once and two different events are never merged. Never content: the
// label is a name the privacy filter already kept, the number and flag are
// measures.
import type { SessionEventKind } from "../store/observatory-rows.ts";
import type { SessionEventWrite, WriteOp } from "../store/write-ops.ts";

export type SessionEventFacts = {
  sessionId: string;
  at: number;
  agentId?: string | null | undefined;
  toolUseId?: string | null | undefined;
  station?: string | null | undefined;
  label?: string | null | undefined;
  number?: number | null | undefined;
  flag?: boolean | null | undefined;
};

/** The dedupe key of an event of `kind` in `sessionId`, told apart by `parts` (ids, a time, a label). */
export function sessionEventKey(kind: SessionEventKind, sessionId: string, parts: readonly (string | number | null | undefined)[]): string {
  return `${kind}:${JSON.stringify([sessionId, ...parts.map((p) => p ?? null)])}`;
}

/** The write of an event of `kind`, keyed by `parts` (sessionEventKey). */
export function sessionEventOp(kind: SessionEventKind, facts: SessionEventFacts, parts: readonly (string | number | null | undefined)[]): WriteOp {
  const row: SessionEventWrite = {
    dedupeKey: sessionEventKey(kind, facts.sessionId, parts),
    sessionId: facts.sessionId,
    at: facts.at,
    kind,
    agentId: facts.agentId,
    toolUseId: facts.toolUseId,
    station: facts.station,
    label: facts.label,
    number: facts.number,
    flag: facts.flag,
  };
  return { kind: "sessionEvent", row };
}
