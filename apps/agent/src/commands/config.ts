// `tunelo config local-forward [on|off|block|unblock] [ports…]`: whether
// Localman may send requests to localhost on this machine
// (tunnels/forward.ts), and ports it never reaches here. The running service
// makes the change when its control channel answers; otherwise the command
// writes local-forward.json itself, under the same lock the service uses,
// and a service that is starting reads it again (forward-settings.ts).
// Every change goes to the consent log.
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { callControl, controlAnswers } from "../control-socket.ts";
import { AuditLog } from "../safety/audit-log.ts";
import { ForwardDenyList } from "../tunnels/forward-deny-ports.ts";
import { LocalForward, type LocalForwardState } from "../tunnels/forward.ts";
import { ForwardSettings } from "../tunnels/forward-settings.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

const ACTIONS = ["on", "off", "block", "unblock", "status"] as const;
type Action = (typeof ACTIONS)[number];

/** Ports given on the command line; throws on anything that is not 1–65535. */
export function parsePorts(values: readonly string[]): number[] {
  if (values.length === 0) throw new Error("give one or more ports, e.g. `tunelo config local-forward block 8080 3001`");
  return values.flatMap((v) => v.split(",")).filter(Boolean).map((v) => {
    const n = Number(v);
    if (!/^\d{1,5}$/.test(v) || n < 1 || n > 65_535) throw new Error(`${v} is not a port (1-65535)`);
    return n;
  });
}

/** The forwarding of the config folder `dir`, for changes while the service does not answer. */
function offline(dir: string): LocalForward {
  const settings = new ForwardSettings(dir);
  return new LocalForward({
    settings,
    audit: new AuditLog(join(dir, "audit.jsonl")),
    log: () => undefined,
    deny: new ForwardDenyList({ configDir: dir, ownPorts: () => [], extraPorts: () => settings.read().blockedPorts }),
  });
}

export function describeLocalForward(state: LocalForwardState, running: boolean): string[] {
  const lines = [
    state.enabled
      ? "Forwarding to localhost: on. Localman, signed in with this machine's account, may send requests to localhost:<port> here."
      : "Forwarding to localhost: off. Localman gets “turned off” for this machine. Turn it on with `tunelo config local-forward on`.",
  ];
  if (!running) lines.push("The background service is not running (`tunelo login` starts it): nothing is forwarded until it runs.");
  else if (state.enabled && !state.available) lines.push("The tunnel server does not carry these requests yet (or the machine tunnel is not connected): nothing is forwarded for now.");
  lines.push(
    "Never forwarded: Docker, debug, database and admin ports of the built-in list, tunelo's own ports, Claude Code IDE ports, and debug ports of running processes.",
  );
  if (state.blockedPorts.length > 0) lines.push(`Also never forwarded on this machine: ${state.blockedPorts.join(", ")}.`);
  return lines;
}

async function localForward(action: string | undefined, ports: string[]): Promise<number> {
  const chosen = (action ?? "status").toLowerCase();
  if (!(ACTIONS as readonly string[]).includes(chosen)) throw new Error(`unknown action ${chosen}: use on, off, block or unblock`);
  const act = chosen as Action;
  const dir = configDir();
  const running = await controlAnswers(dir);
  let state: LocalForwardState;
  if (act === "status") {
    state = running ? ((await callControl(dir, "GET", "/local-forward")) as LocalForwardState) : offline(dir).state();
  } else if (act === "on" || act === "off") {
    const enabled = act === "on";
    state = running ? ((await callControl(dir, "POST", "/local-forward", { enabled })) as LocalForwardState) : await offline(dir).setEnabled(enabled, "local");
  } else {
    const list = parsePorts(ports);
    const blocked = act === "block";
    state = running ? ((await callControl(dir, "POST", "/local-forward/blocked", { ports: list, blocked })) as LocalForwardState) : await offline(dir).setBlocked(list, blocked, "local");
  }
  for (const line of describeLocalForward(state, running)) console.log(line);
  return 0;
}

/** Adds `local-forward` under `tunelo config`. */
export function registerLocalForwardCommand(config: Command, exits: Exits): void {
  config
    .command("local-forward [action] [ports...]", { hidden: true })
    .description("let Localman send requests to localhost on this machine: on, off, block <ports…>, unblock <ports…>; no action shows the state")
    .action(exits((action: string | undefined, ports: string[]) => localForward(action, ports)));
}
