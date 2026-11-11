// Updates tunelo for a paired device: the same signed download as
// `tunelo update` (update.ts), with the steps reported back so the device can
// show them, and a look for newer releases every few hours so a device can
// offer the update before anyone asks.
import { AgentUpdatePhase } from "@achoo254/chat-proto/remote/remote";
import { checkForUpdate, type DownloadProgress, update } from "./update.ts";

export class UpdateUnavailable extends Error {}
export class UpdateBusy extends Error {}

export type UpdateProgress = { phase: AgentUpdatePhase; version: string; received: number; total: number; message: string };

export type AgentUpdaterDeps = {
  /** This tunelo can replace its own file and something starts it again afterwards. */
  supported: () => boolean;
  /** A change of what MachineInfo says (a newer release found, an update started or ended). */
  announce: () => void;
  /** Progress, to every connected device. */
  emit: (progress: UpdateProgress) => void;
  /** Ends the process once the new file is in place, so the supervisor starts it. */
  restart: () => void;
  log: (line: string) => void;
  /** Overridable for tests. */
  check?: () => Promise<string | null>;
  install?: typeof update;
  checkEveryMs?: number;
};

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Progress of a download goes out at most this often. */
const PROGRESS_EVERY_MS = 250;

export class AgentUpdater {
  private latest = "";
  private updating = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: AgentUpdaterDeps) {}

  info(): { supported: boolean; latestVersion: string; updating: boolean } {
    return { supported: this.deps.supported(), latestVersion: this.latest, updating: this.updating };
  }

  /** Looks for a release now, then every few hours. */
  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.checkEveryMs ?? CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Asks the release list; a failure leaves what was known. */
  async check(): Promise<void> {
    try {
      const latest = (await (this.deps.check ?? checkForUpdate)()) ?? "";
      if (latest === this.latest) return;
      this.latest = latest;
      this.deps.announce();
    } catch (err) {
      this.deps.log(`update check: ${(err as Error).message}`);
    }
  }

  /** Throws when an update cannot start now. */
  assertCanRun(): void {
    if (!this.deps.supported()) throw new UpdateUnavailable("this tunelo cannot update itself here; run `tunelo update` on the machine");
    if (this.updating) throw new UpdateBusy("tunelo is already updating");
  }

  /** Runs the update; progress goes out through `emit`, and it never rejects. */
  async run(): Promise<void> {
    this.assertCanRun();
    this.updating = true;
    this.deps.announce();
    let version = this.latest;
    const say = (phase: AgentUpdatePhase, extra: Partial<UpdateProgress> = {}) =>
      this.deps.emit({ phase, version, received: 0, total: 0, message: "", ...extra });
    let lastSent = 0;
    const onProgress: DownloadProgress = (received, total) => {
      const now = Date.now();
      if (received < total && now - lastSent < PROGRESS_EVERY_MS) return;
      lastSent = now;
      say(AgentUpdatePhase.DOWNLOADING, { received, total });
    };
    try {
      say(AgentUpdatePhase.DOWNLOADING);
      const installed = await (this.deps.install ?? update)(
        (l) => this.deps.log(l),
        onProgress,
        (phase) => say(phase === "verifying" ? AgentUpdatePhase.VERIFYING : AgentUpdatePhase.INSTALLING),
      );
      if (!installed) {
        this.latest = "";
        say(AgentUpdatePhase.UP_TO_DATE);
        return;
      }
      version = installed;
      say(AgentUpdatePhase.RESTARTING);
      this.deps.log(`updated to ${installed} from a device; restarting`);
      this.deps.restart();
    } catch (err) {
      this.deps.log(`update failed: ${(err as Error).message}`);
      say(AgentUpdatePhase.FAILED, { message: (err as Error).message.slice(0, 300) });
    } finally {
      this.updating = false;
      this.deps.announce();
    }
  }
}
