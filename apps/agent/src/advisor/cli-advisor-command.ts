// `tunelo advisor set-key | remove-key | status`: Advisor's TypeSafe key from
// the machine's own terminal (devices set it end-to-end encrypted instead).
// The command writes Advisor's own store (advisor-key-store.ts) itself, then
// tells the running service, which hides the key from its output and tells
// every device; the key never goes through the control channel.
//
// Setting the key reads it only from a real terminal, without echo: never
// from an argument (shell history, process list), a pipe or a file, so an AI
// session's shell tool or a script cannot plant a key. Removing it needs a
// terminal too, so a script cannot drop the key in the user's name. The
// command itself is one only a person at the machine should run
// (safety/sensitive-paths.ts).
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { AuditLog } from "../safety/audit-log.ts";
import { AdvisorKeyStore, type AdvisorKeyStatus } from "./advisor-key-store.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

/** The person at the keyboard, if any. */
export interface KeyTerminal {
  /** stdin is a terminal (not a pipe or a file). */
  interactive: boolean;
  /** Reads one line without echoing it. */
  readHidden(prompt: string): Promise<string>;
  print(line: string): void;
  printError(line: string): void;
}

/** Who sets a key from the machine's own terminal, in the consent log and on devices. */
export const LOCAL_DEVICE = "local";

export const NEEDS_TERMINAL =
  "tunelo: the Advisor key is changed only from a terminal. Run `tunelo advisor set-key` (or `remove-key`) yourself in a terminal window, not from an AI session, a script or a pipe; set-key asks for the key without echo.";

/** Ctrl-C, or stdin ending before Enter. */
const CANCELLED = "cancelled; nothing was changed";

const ACTIONS = ["set-key", "remove-key", "status"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

function describe(status: AdvisorKeyStatus): string {
  if (!status.keySet) return "Advisor key: none on this machine.";
  const by = status.setByDevice ? ` by ${status.setByDevice}` : "";
  const at = status.setAt > 0 ? ` on ${new Date(status.setAt).toISOString()}` : "";
  return `Advisor key: set (fingerprint ${status.fingerprint})${by}${at}.`;
}

export type AdvisorCommandDeps = {
  dir: string;
  term: KeyTerminal;
  /** Tells the running service the key changed; rejects when none runs. */
  notify: () => Promise<unknown>;
};

/** Runs the command against the config folder; returns the exit code. */
export async function runAdvisorCommand(action: string, deps: AdvisorCommandDeps): Promise<number> {
  const { dir, term } = deps;
  if (!isAction(action)) {
    term.printError(`tunelo: unknown action ${action.slice(0, 40)}: use set-key, remove-key or status`);
    return 1;
  }
  const store = new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) });
  if (action === "status") {
    term.print(describe(store.status()));
    return 0;
  }
  if (!term.interactive) {
    term.printError(NEEDS_TERMINAL);
    return 1;
  }
  let status: AdvisorKeyStatus;
  try {
    status = action === "set-key" ? await store.set(await term.readHidden("TypeSafe key (not shown): "), LOCAL_DEVICE) : await store.remove(LOCAL_DEVICE);
  } catch (err) {
    // Every refusal here is a fixed message (AdvisorKeyError, CANCELLED): it never quotes the key.
    term.printError(`tunelo: ${err instanceof Error ? err.message : CANCELLED}`);
    return 1;
  }
  term.print(describe(status));
  try {
    await deps.notify();
  } catch {
    term.print("tunelo is not running; the change applies when it starts.");
  }
  return 0;
}

/** Reads a line from the terminal in raw mode, echoing nothing; Ctrl-C cancels. */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    let value = "";
    const finish = (err?: Error): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error(CANCELLED));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    const onEnd = (): void => finish(new Error(CANCELLED));
    input.on("data", onData);
    input.once("end", onEnd);
  });
}

function processTerminal(): KeyTerminal {
  return {
    interactive: process.stdin.isTTY === true,
    readHidden: readHiddenLine,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  };
}

/** Adds `tunelo advisor`, kept off the help like the other commands only a person at the machine runs. */
export function registerAdvisorCommand(program: Command, exits: Exits): void {
  program
    .command("advisor <action>", { hidden: true })
    .description("Advisor's TypeSafe key on this machine: set-key (asks in a terminal, without echo), remove-key, status")
    .action(
      exits((action: string) => {
        const dir = configDir();
        return runAdvisorCommand(action, { dir, term: processTerminal(), notify: () => callControl(dir, "POST", "/advisor/changed") });
      }),
    );
}
