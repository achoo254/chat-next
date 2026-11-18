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
//
// `tunelo advisor note <thread>` is no command for a person: it is the
// UserPromptSubmit hook tunelo gives the AI's CLI in a terminal (Claude's
// terminalCommand). It reads the hook's JSON on stdin, asks the running
// service for Advisor's note on the message, and prints it as the hook's
// additionalContext. Whatever goes wrong (no service, a timeout, input it
// cannot read) it prints `{}` and exits 0: the user's message always goes on
// as typed.
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { ADVISOR_NOTE_PROMPT_CHARS, callControl } from "../control-socket.ts";
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
  const whose = status.source === "account" ? "the account's key" : "this machine's own key";
  return `Advisor key: ${whose}, set (fingerprint ${status.fingerprint})${by}${at}.`;
}

export type AdvisorCommandDeps = {
  dir: string;
  term: KeyTerminal;
  /** Tells the running service the key changed; rejects when none runs. */
  notify: () => Promise<unknown>;
};

/** How long the hook may take, all told: it runs before every message typed in the terminal. */
export const NOTE_TIMEOUT_MS = 1_500;
/** The service hands out no note this close to the hook giving up (the answer still has to come back). */
const NOTE_DEADLINE_MARGIN_MS = 200;
/** The most of the hook's JSON read from stdin (a pasted message can be long; only its start matters). */
const NOTE_STDIN_MAX = 1024 * 1024;

export type AdvisorNoteDeps = {
  /** The hook's JSON on stdin; may reject or never settle. */
  readStdin: () => Promise<string>;
  /** Asks the running service (POST /advisor/note); may reject or never settle. */
  ask: (body: { thread: string; prompt: string; session?: string; deadline: number }) => Promise<unknown>;
  /** Writes the one line the hook prints. */
  print: (line: string) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
};

/** What the hook's JSON tells: the start of the prompt and the CLI's session id; undefined when it is no hook JSON. */
function hookInput(raw: string): { prompt: string; session?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { prompt, session_id: session } = parsed as { prompt?: unknown; session_id?: unknown };
  if (typeof prompt !== "string") return undefined;
  const start = prompt.trimStart().slice(0, ADVISOR_NOTE_PROMPT_CHARS);
  return typeof session === "string" && session !== "" && session.length <= 128 ? { prompt: start, session } : { prompt: start };
}

/** What the service answered: its note, or undefined for none or anything else. */
function noteOf(answer: unknown): string | undefined {
  const note = typeof answer === "object" && answer !== null ? (answer as { note?: unknown }).note : undefined;
  return typeof note === "string" && note !== "" ? note : undefined;
}

/** `tunelo advisor note <thread>`: prints the hook's output (Advisor's note, or `{}`); always exits 0. */
export async function runAdvisorNote(thread: string, deps: AdvisorNoteDeps): Promise<number> {
  const timeoutMs = deps.timeoutMs ?? NOTE_TIMEOUT_MS;
  const deadline = (deps.now ?? Date.now)() + timeoutMs - Math.min(NOTE_DEADLINE_MARGIN_MS, timeoutMs / 2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const work = (async (): Promise<string | undefined> => {
    const input = hookInput(await deps.readStdin());
    if (input === undefined) return undefined;
    return noteOf(await deps.ask({ thread, ...input, deadline }));
  })().catch(() => undefined);
  const note = await Promise.race([work, timeout]);
  clearTimeout(timer);
  const out = note === undefined ? {} : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note } };
  try {
    await deps.print(JSON.stringify(out));
  } catch {
    // stdout closed: the CLI went on without the hook's answer.
  }
  return 0;
}

/** stdin to its end (at most NOTE_STDIN_MAX bytes); "" when it is a terminal (no hook runs the command). */
function readStdin(): Promise<string> {
  const input = process.stdin;
  if (input.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    input.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > NOTE_STDIN_MAX) {
        input.destroy();
        reject(new Error("the hook's input is too long"));
        return;
      }
      chunks.push(chunk);
    });
    input.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    input.once("error", reject);
  });
}

function printLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

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
    .command("advisor <action> [thread]", { hidden: true })
    .description("Advisor's TypeSafe key on this machine: set-key (asks in a terminal, without echo), remove-key, status")
    .action(
      exits((action: string, thread: string | undefined) => {
        const dir = configDir();
        // The hook of a thread's CLI in a terminal (see the top of this file).
        if (action === "note" && thread !== undefined) {
          return runAdvisorNote(thread, { readStdin, ask: (body) => callControl(dir, "POST", "/advisor/note", body), print: printLine });
        }
        return runAdvisorCommand(action, { dir, term: processTerminal(), notify: () => callControl(dir, "POST", "/advisor/changed") });
      }),
    );
}
