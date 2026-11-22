// The `seq` of an instruction load: its place among the loads of the same
// file for the same reason in a session, the last part of the key
// (session, file, reason, seq) that tells one load from a copy of it. The
// numbers must survive the agent's restart, so the first time a process sees
// a (session, file, reason) it reads the loads already stored (once, read
// only) and then:
// - a load seen before in this process from the same source (the same spool
//   line read again) keeps its number;
// - a load within LOAD_MATCH_MS of a stored load its source has not matched
//   yet is that load (the same line read again after a restart, or the other
//   source's copy: the SDK callback's and the spool's times differ by the
//   hook's start-up) and takes its number;
// - any other load is new: the next number after the stored ones, counted per
//   source, so the n-th new load from the SDK callback and the n-th from the
//   spool are one row.
import type { RecordOrigin } from "../privacy/filtered-record.ts";
import { BoundedMap } from "./bounded-map.ts";
import type { InstructionLoad } from "./normalized-record.ts";

/** Two copies of one load are at most this far apart. */
export const LOAD_MATCH_MS = 10_000;
const MAX_ENTRIES = 20_000;

/** A load already stored: its number and time. */
export type StoredLoad = { seq: number; at: number };

/** The loads of `filePath` for `loadReason` stored for `sessionId`; [] when the store cannot tell now. */
export type StoredLoads = (sessionId: string, filePath: string, loadReason: string) => readonly StoredLoad[];

type PerSource = { next: number; matched: Set<number> };

export class InstructionLoadSeq {
  /** The stored loads of each (session, file, reason), read once. */
  private readonly stored = new BoundedMap<string, readonly StoredLoad[]>(MAX_ENTRIES);
  private readonly sources = new BoundedMap<string, PerSource>(MAX_ENTRIES);
  private readonly seen = new BoundedMap<string, number>(MAX_ENTRIES);

  constructor(private readonly storedLoads: StoredLoads) {}

  /** The number of `load` from `origin`. */
  seqOf(load: InstructionLoad, origin: RecordOrigin): number {
    const same = JSON.stringify([load.sessionId, load.filePath, load.loadReason]);
    const one = JSON.stringify([origin, same, load.at]);
    const known = this.seen.get(one);
    if (known !== undefined) return known;
    const read = this.storedOf(same, load);
    const stored = read ?? [];
    const sourceKey = JSON.stringify([origin, same]);
    let source = this.sources.get(sourceKey);
    if (!source) {
      source = { next: stored.reduce((max, s) => Math.max(max, s.seq + 1), 0), matched: new Set() };
      // Without the stored loads the count is a guess: not kept, so the next load asks the store again.
      if (read) this.sources.set(sourceKey, source);
    }
    let seq: number;
    const match = closestUnmatched(stored, source.matched, load.at);
    if (match) {
      seq = match.seq;
      source.matched.add(seq);
    } else {
      seq = source.next++;
    }
    // A guess made without the stored loads is not remembered: the same load read again is numbered from the store.
    if (read) this.seen.set(one, seq);
    return seq;
  }

  /** The stored loads, read once; undefined when the store cannot be read now (busy, closed): asked again next time. */
  private storedOf(same: string, load: InstructionLoad): readonly StoredLoad[] | undefined {
    const cached = this.stored.get(same);
    if (cached) return cached;
    let rows: readonly StoredLoad[];
    try {
      rows = this.storedLoads(load.sessionId, load.filePath, load.loadReason);
    } catch {
      return undefined;
    }
    this.stored.set(same, rows);
    return rows;
  }
}

function closestUnmatched(stored: readonly StoredLoad[], matched: ReadonlySet<number>, at: number): StoredLoad | undefined {
  let best: StoredLoad | undefined;
  for (const s of stored) {
    if (matched.has(s.seq) || Math.abs(s.at - at) > LOAD_MATCH_MS) continue;
    if (!best || Math.abs(s.at - at) < Math.abs(best.at - at)) best = s;
  }
  return best;
}
