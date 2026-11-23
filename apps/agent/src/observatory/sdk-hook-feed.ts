// Hook events of the Claude sessions the agent runs through the Agent SDK,
// on their way to the ingest. A hook callback sits on Claude's path: Claude
// waits for it before the tool runs or the turn goes on, so the callback only
// puts the raw payload in a bounded queue and returns. The queue is worked
// off on the next turn of the event loop: each payload is filtered with both
// privacy passes at once (privacy/filter-hook-event.ts, stage "final"),
// tagged with the session's internal label when it has one (an Advisor
// session, left out of every total), and handed to the ingest as an "sdk"
// record. Nothing here waits on the store or the network, and nothing throws
// back into a session: a payload past the queue's bound, or one the filter
// cannot use, is only counted.
import { INTERNAL_LABEL_FIELD } from "./ingest/record-known-fields.ts";
import type { FilteredHookRecord } from "./privacy/filtered-record.ts";
import { filterHookEvent } from "./privacy/filter-hook-event.ts";
import { isKeptHookEvent } from "./privacy/hook-allowlist.ts";

/** Payloads waiting at most; more are dropped (and counted) until the queue drains. */
export const SDK_FEED_MAX_QUEUED = 1_000;
/** Folders whose project key is remembered (usage/repo-key.ts reads git's files for each new one). */
const MAX_PROJECT_KEYS = 512;

export type SdkFeedStats = {
  /** Payloads taken from the callbacks. */
  taken: number;
  /** Payloads dropped because the queue was full. */
  dropped: number;
  /** Payloads of an event not kept, or not an object. */
  ignored: number;
  /** Records handed to the ingest. */
  fed: number;
  /** Records the ingest refused, or a filter failure (a bug). */
  failed: number;
};

export type SdkHookFeedOptions = {
  /** Hands a record to the ingest (ObservatoryService.accept). */
  accept: (record: FilteredHookRecord) => Promise<void>;
  home: string;
  isSensitive: (absolutePath: string) => boolean;
  /** The project key of a working folder (usage/repo-key.ts). */
  repoKey: (cwd: string) => string;
  /** Whether a project's content is kept now (the config's projects without content; unknown is off once any project is off). */
  contentAllowed: (projectKey: string | undefined) => boolean;
  /** The secret values the agent hides (the machine's and the receiver's tokens). */
  known: () => Iterable<string>;
  accountNames?: readonly string[];
  /** The machine's salt for `target_key` now (privacy/target-key-salt.ts); undefined keeps no key. */
  targetKeySalt?: () => Uint8Array | undefined;
  /** Whether Observatory is on now: off, a payload is not even queued. */
  enabled: () => boolean;
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  /** Schedules the queue's work (setImmediate by default). */
  schedule?: (work: () => void) => void;
};

type Queued = { event: string; payload: unknown; at: number; label: string | undefined };

export class SdkHookFeed {
  readonly stats: SdkFeedStats = { taken: 0, dropped: 0, ignored: 0, fed: 0, failed: 0 };
  private queue: Queued[] = [];
  private scheduled = false;
  private readonly projectKeys = new Map<string, string | undefined>();
  private readonly now: () => number;
  private readonly schedule: (work: () => void) => void;

  constructor(private readonly opts: SdkHookFeedOptions) {
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((work) => void setImmediate(work));
  }

  /** Takes one payload of a session's hook `event`; returns at once and never throws. `label` marks an internal session. */
  take(event: string, payload: unknown, label?: string): void {
    try {
      if (!this.opts.enabled()) return;
      this.stats.taken++;
      if (this.queue.length >= SDK_FEED_MAX_QUEUED) {
        this.stats.dropped++;
        return;
      }
      this.queue.push({ event, payload, at: this.now(), label });
      if (this.scheduled) return;
      this.scheduled = true;
      this.schedule(() => this.drain());
    } catch (err) {
      this.stats.failed++;
      this.opts.problems("sdk-hook", err);
    }
  }

  /** Payloads waiting now. */
  get queued(): number {
    return this.queue.length;
  }

  private drain(): void {
    this.scheduled = false;
    const work = this.queue;
    this.queue = [];
    for (const item of work) this.feed(item);
  }

  private feed(item: Queued): void {
    try {
      if (!isKeptHookEvent(item.event)) {
        this.stats.ignored++;
        return;
      }
      const cwd = typeof item.payload === "object" && item.payload !== null ? (item.payload as { cwd?: unknown }).cwd : undefined;
      const projectKey = this.projectKeyOf(cwd);
      const filtered = filterHookEvent(
        item.event,
        item.payload,
        {
          home: this.opts.home,
          isSensitive: this.opts.isSensitive,
          contentAllowed: this.opts.contentAllowed(projectKey),
          known: this.opts.known(),
          stage: "final",
          projectKey,
          targetKeySalt: this.opts.targetKeySalt?.(),
          ...(this.opts.accountNames ? { accountNames: this.opts.accountNames } : {}),
        },
        item.at,
      );
      if (!filtered) {
        this.stats.ignored++;
        return;
      }
      // Every record of an internal session carries its label: the session's row is written again from any of them (after a wipe too).
      const record: FilteredHookRecord = item.label ? { ...filtered, f: { ...filtered.f, [INTERNAL_LABEL_FIELD]: item.label } } : filtered;
      this.stats.fed++;
      this.opts.accept(record).catch((err: unknown) => {
        this.stats.failed++;
        this.opts.problems("sdk-hook", err);
      });
    } catch (err) {
      this.stats.failed++;
      this.opts.problems("sdk-hook", err);
    }
  }

  /** The project key of the session's real folder, worked out once per folder. */
  private projectKeyOf(cwd: unknown): string | undefined {
    if (typeof cwd !== "string" || cwd === "") return undefined;
    if (this.projectKeys.has(cwd)) return this.projectKeys.get(cwd);
    let key: string | undefined;
    try {
      key = this.opts.repoKey(cwd);
    } catch {
      key = undefined;
    }
    if (this.projectKeys.size >= MAX_PROJECT_KEYS) this.projectKeys.clear();
    this.projectKeys.set(cwd, key);
    return key;
  }
}
