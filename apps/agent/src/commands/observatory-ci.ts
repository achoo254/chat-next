// `tunelo observatory ci <on|off>`: the CI watcher's switch
// (observatory/ci/ci-watcher.ts: GitHub Actions followed after a session's
// push, on by default). With the agent running the change goes through its
// control channel (the agent owns the config); without it the command writes
// the config itself. Every change goes to the consent log (audit.jsonl), as
// the thresholds' switch.
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { ConfigStore } from "../config.ts";
import { setCiWatchEnabled } from "../observatory/ci/ci-watch-config.ts";
import { AuditLog } from "../safety/audit-log.ts";
import type { ObservatoryCliDeps } from "./observatory-actions.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;
type CiDeps = Pick<ObservatoryCliDeps, "dir" | "call" | "running" | "term">;

const switchInput = z.object({ enabled: z.boolean() });

/** What the route uses of the machine: its config (the watcher reads the switch at every push and poll) and the consent log. */
type CiMachine = { readonly config: ConfigStore; readonly audit: AuditLog };
type CiRoute = (target: { machine?: CiMachine | undefined }, input: unknown) => unknown;

/** The switch written to the config and the consent log. */
function applyCiSwitch(config: ConfigStore, audit: AuditLog, enabled: boolean): void {
  setCiWatchEnabled(config, enabled);
  audit.write({ device: "local", action: "observatory_ci", path: "", detail: enabled ? "ci watch on" : "ci watch off" });
}

/** The control channel's route of this command (control-socket.ts). */
export const OBSERVATORY_CI_ROUTES: Readonly<Record<string, CiRoute>> = {
  "POST /observatory/ci": (t, input) => {
    if (!t.machine) throw new Error("this tunelo runs tunnels only");
    const { enabled } = switchInput.parse(input);
    applyCiSwitch(t.machine.config, t.machine.audit, enabled);
    return { enabled };
  },
};

/** `tunelo observatory ci <on|off>`. */
export async function observatoryCiCommand(deps: CiDeps, action: string): Promise<number> {
  const chosen = action.toLowerCase();
  if (chosen !== "on" && chosen !== "off") throw new Error(`unknown action ${action}: use on or off`);
  const enabled = chosen === "on";
  if (await deps.running()) await deps.call("POST", "/observatory/ci", { enabled });
  else applyCiSwitch(new ConfigStore(deps.dir), new AuditLog(join(deps.dir, "audit.jsonl")), enabled);
  deps.term.print(enabled ? "GitHub Actions runs are followed after a push again." : "GitHub Actions runs are no longer followed after a push; events already stored stay.");
  return 0;
}

/** Adds `ci` to `tunelo observatory`. */
export function registerObservatoryCiCommand(observatory: Command, exits: Exits, deps: () => CiDeps): void {
  observatory
    .command("ci <action>")
    .description("on or off: follow GitHub Actions runs after a session's push, with the gh CLI (on by default)")
    .action(exits((action: string) => observatoryCiCommand(deps(), action)));
}
