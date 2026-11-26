// What a report's sessions left in git: the commits made in the session's
// folder while it ran (from its first call to ten minutes after its last) and
// the files those commits changed, read from the repository on the machine.
// Counts only leave the machine: never a hash, a message or a path.
//
// It is an estimate: commits are matched by time, not by who made them, so
// two sessions working in one repository at the same time both count a
// commit made then. A folder outside git, or git failing or too slow, gives
// no outcome. Results are kept in memory by folder and time span, so asking
// the same report again runs no git.
import { gitRead } from "../projects/git.ts";
import type { ReportSession } from "./report.ts";

export type Outcome = { commits: number; filesChanged: number };

/** Runs `git <args>` in a folder; undefined when it fails. */
export type GitLog = (dir: string, args: readonly string[]) => Promise<string | undefined>;

/** Time after a session's last call a commit still counts (the AI commits, then the turn ends). */
export const OUTCOME_GRACE_MS = 10 * 60_000;
const CONCURRENCY = 4;
const TIMEOUT_MS = 3_000;
const CACHE_MAX = 500;
const HASH = /^[0-9a-f]{40,64}$/;
const FILES = /(\d+) files? changed/;

const defaultGit: GitLog = (dir, args) => gitRead(dir, args, TIMEOUT_MS, 1024 * 1024);

/** `git log --format=%H --shortstat` output → commits and files changed. */
export function parseLog(out: string): Outcome {
  const hashes = new Set<string>();
  let filesChanged = 0;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (HASH.test(line)) hashes.add(line);
    else {
      const m = FILES.exec(line);
      if (m) filesChanged += Number(m[1]);
    }
  }
  return { commits: hashes.size, filesChanged };
}

/** The key of a session in the map `sessionOutcomes` returns. */
export const outcomeKey = (s: Pick<ReportSession, "provider" | "sessionId">) => `${s.provider}\u0000${s.sessionId}`;

export class OutcomeReader {
  private readonly cache = new Map<string, Outcome | null>();

  constructor(private readonly git: GitLog = defaultGit) {}

  /** The outcome of each session it could read, by outcomeKey. */
  async read(sessions: readonly ReportSession[]): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const queue = sessions.filter((s) => s.cwd !== "");
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const o = await this.one(s);
        if (o) out.set(outcomeKey(s), o);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out;
  }

  private async one(s: ReportSession): Promise<Outcome | undefined> {
    // Minutes are enough: a running session's span moves, and is read again, once a minute at most.
    const since = Math.floor(s.firstAt / 60_000) * 60_000;
    const until = Math.ceil((s.lastAt + OUTCOME_GRACE_MS) / 60_000) * 60_000;
    const key = `${s.cwd}\u0000${since}\u0000${until}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const log = await this.git(s.cwd, ["log", "--no-merges", `--since=${new Date(since).toISOString()}`, `--until=${new Date(until).toISOString()}`, "--format=%H", "--shortstat"]);
    const outcome = log === undefined ? null : parseLog(log);
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, outcome);
    return outcome ?? undefined;
  }
}
