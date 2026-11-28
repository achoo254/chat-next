// Observatory as one of tunelo's services a device sees on the machine's page
// (MachineInfo.runtime): whether its receiver runs, and if not why, and the
// switch a device turns it on, off or restarts it with (AgentServiceControl).
// On and off are kept in tunelo's settings (`observatory.enabled`), as an
// edit of config.json by hand would; a restart keeps them.
import type { ConfigStore } from "../config.ts";
import type { ObservatoryStatus } from "./observatory-status.ts";

export type ObservatoryRuntime = {
  state: "running" | "off" | "port-taken" | "failed";
  /** The receiver's port; 0 when it has none (never picked, or no free port in the range). */
  port: number;
  /** Why it does not run, when state is failed. */
  problem?: "token-unreadable" | "no-free-port" | "store-failed" | "other";
};

/** The receiver's state as a device is told it, from Observatory's status and the port kept in the settings. */
export function observatoryRuntime(status: ObservatoryStatus, configPort: number | undefined): ObservatoryRuntime {
  const port = status.receiver.port ?? configPort ?? 0;
  if (!status.enabled) return { state: "off", port };
  if (status.store === "failed") return { state: "failed", port, problem: "store-failed" };
  switch (status.receiver.state) {
    case "listening":
      return { state: "running", port };
    case "port-taken":
      return { state: "port-taken", port };
    case "token-unreadable":
      return { state: "failed", port, problem: "token-unreadable" };
    case "no-port":
      return { state: "failed", port: 0, problem: "no-free-port" };
    // On but not started yet, or between a stop and a start of a restart.
    case "off":
      return { state: "off", port };
    default:
      return { state: "failed", port, problem: "other" };
  }
}

/** What the switch needs of ObservatoryService: both never reject, and start() works again after stop(). */
export type ObservatoryLifecycle = { start(): Promise<void>; stop(): Promise<void> };

/** Turns Observatory on, off or restarts it; one change at a time, in the order asked. */
export class ObservatorySwitch {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: ObservatoryLifecycle,
    private readonly config: ConfigStore,
  ) {}

  /** Keeps `on` in the settings, then stops and starts the service so every part follows it; nothing when it already is. */
  setEnabled(on: boolean): Promise<void> {
    return this.serial(async () => {
      if ((this.config.get().observatory?.enabled !== false) === on) return;
      this.config.update((c) => (c.observatory = { ...c.observatory, enabled: on }));
      await this.cycle();
    });
  }

  /** Stops and starts it again, the settings unchanged. */
  restart(): Promise<void> {
    return this.serial(() => this.cycle());
  }

  private async cycle(): Promise<void> {
    await this.service.stop();
    await this.service.start();
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
