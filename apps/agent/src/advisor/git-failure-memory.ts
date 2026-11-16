// What the machine keeps of a failed git write of a workspace, for Advisor:
// a device gets only git's last line (git-run.ts lastLine) and a failure id
// with it (Error.failure_id); a question to Advisor about that failure names
// the id, and the machine adds git's whole output, cleaned on the way out
// (scrub-git-output.ts). Kept in memory only, for FAILURE_TTL_MS, never on
// disk, never sent to a device.
import { randomUUID } from "node:crypto";

/** How long a failure is kept. */
export const FAILURE_TTL_MS = 10 * 60_000;
/** At most this many failures are kept; the oldest go first. */
export const FAILURES_MAX = 50;

/** A failure id as devices send it back (AdvisorContext.failure_id). */
export const FAILURE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type GitFailure = {
  failureId: string;
  workspaceId: string;
  /** The workspace's real folder when it failed: its paths are named relatively on the way out. */
  root: string;
  /** What was done: the request's audit action (git_push, git_pull, …). */
  action: string;
  /**
   * git's whole stderr, as git printed it (not cleaned yet); for a failure
   * git printed nothing for, the refusal's English message and subject.
   */
  output: string;
  at: number;
};

export class GitFailureMemory {
  private readonly kept = new Map<string, GitFailure>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Keeps a failure and returns its new id. */
  record(f: Omit<GitFailure, "failureId" | "at">): string {
    this.sweep();
    const failureId = randomUUID();
    this.kept.set(failureId, { ...f, failureId, at: this.now() });
    while (this.kept.size > FAILURES_MAX) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
    return failureId;
  }

  /** A failure still kept; undefined for an unknown, malformed or expired id. */
  get(failureId: string): GitFailure | undefined {
    if (!FAILURE_ID.test(failureId)) return undefined;
    this.sweep();
    return this.kept.get(failureId);
  }

  private sweep(): void {
    const cutoff = this.now() - FAILURE_TTL_MS;
    for (const [id, f] of this.kept) if (f.at <= cutoff) this.kept.delete(id);
  }
}
