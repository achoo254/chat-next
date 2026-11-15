// Which room of the office a tool call happens in, and how it is acted out.
// Runs on the machine: a shell command is read here only to pick a room;
// only the room's code ever leaves the machine (docs/office-wire.md, part 4).
import { OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import type { ToolKind } from "../providers/types.ts";

export type OfficePlace = { group: OfficeAnimGroup; room: OfficeRoom };

/** tunelo's own MCP in a session (it messages the user): the lobby, not the post room. */
const TUNELO_MCP_PREFIX = "mcp__tunelo__";

/** Words skipped before the command itself. */
const PREFIX_WORDS = new Set(["sudo", "env", "time", "npx", "bunx", "pnpx", "nohup", "exec"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
/** Words of a package manager that run what follows. */
const RUN_WORDS = new Set(["run", "exec", "x", "run-script"]);
/** Flags of a package manager that take a value (`--filter app`). */
const VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"]);

const POST_COMMANDS = new Set(["git", "gh", "rsync", "scp"]);
const QA_COMMANDS = new Set(["vitest", "jest", "pytest", "eslint", "tsc"]);
/** A package script that checks: test, lint, typecheck and the like, also with a suffix (`test:unit`, `lint-fix`). */
const QA_SCRIPT = /^(test|lint|typecheck|tsc|vitest|jest|eslint)([:._-]|$)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The first command of a compound one (`a && b`, `a; b`, `a | b`, one per line). */
function firstCommand(command: string): string {
  return command.split(/&&|\|\||;|\||\r?\n/)[0] ?? "";
}

/** A word as a command name: the file name, lower case, without a Windows program suffix. */
function commandName(word: string): string {
  const base = word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** The words of the first command, environment assignments dropped. */
function words(command: string): string[] {
  const all = firstCommand(command).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < all.length && ENV_ASSIGNMENT.test(all[i] ?? "")) i++;
  return all.slice(i);
}

/**
 * The first word of a command after environment assignments and `sudo`, as a
 * command name ("pnpm", "git"); "" for none. The office's short subject of a
 * shell call.
 */
export function commandHead(command: string): string {
  const w = words(command);
  let i = 0;
  while (i < w.length && commandName(w[i] ?? "") === "sudo") i++;
  return commandName(w[i] ?? "");
}

/** The words that say what a command does: prefixes, package managers' run words and their flags dropped. */
function meaningfulWords(command: string): { head: string; rest: string[]; viaPackageManager: boolean } {
  const w = words(command).map((x) => x.replace(/^["']|["']$/g, ""));
  let i = 0;
  // `env FOO=1 git status`: assignments may follow a prefix word too.
  while (i < w.length && (PREFIX_WORDS.has(commandName(w[i] ?? "")) || ENV_ASSIGNMENT.test(w[i] ?? ""))) i++;
  const head = commandName(w[i] ?? "");
  if (!PACKAGE_MANAGERS.has(head)) return { head, rest: w.slice(i + 1), viaPackageManager: false };
  i++;
  while (i < w.length) {
    const word = w[i] ?? "";
    if (VALUE_FLAGS.has(word)) i += 2;
    else if (word.startsWith("-") || RUN_WORDS.has(word)) i++;
    else break;
  }
  return { head: (w[i] ?? "").toLowerCase(), rest: w.slice(i + 1), viaPackageManager: true };
}

/** The room of a shell command: git, deploys and copies to other hosts → POST; tests, lint, typecheck → QA; anything else → SERVER. */
export function classifyCommand(command: string): OfficeRoom {
  const { head, rest, viaPackageManager } = meaningfulWords(command);
  const all = [head, ...rest].map((x) => x.toLowerCase());
  if (POST_COMMANDS.has(head) || all.some((x) => x.includes("deploy"))) return OfficeRoom.POST;
  if (QA_COMMANDS.has(head) || ((head === "go" || head === "cargo") && rest[0] === "test")) return OfficeRoom.QA;
  // A runner started through another (`python -m pytest`, `uv run pytest`).
  if (rest.slice(0, 3).some((x) => QA_COMMANDS.has(commandName(x)))) return OfficeRoom.QA;
  if (viaPackageManager && QA_SCRIPT.test(head)) return OfficeRoom.QA;
  return OfficeRoom.SERVER;
}

/** A subagent walking in. */
export const ARRIVE: OfficePlace = { group: OfficeAnimGroup.ARRIVE, room: OfficeRoom.LOBBY };
/** A subagent handing in its work. */
export const HAND_IN: OfficePlace = { group: OfficeAnimGroup.HAND_IN, room: OfficeRoom.DIRECTOR };
/** The director thinking or writing the answer. */
export const THINK: OfficePlace = { group: OfficeAnimGroup.THINK, room: OfficeRoom.DIRECTOR };

/** Where and how a tool call is acted out, by its kind, name and (for a shell) command. */
export function classifyActivity(tool: { kind: ToolKind; name: string; command?: string }): OfficePlace {
  switch (tool.kind) {
    case "read":
    case "search":
      return { group: OfficeAnimGroup.READ, room: OfficeRoom.LIBRARY };
    case "web":
      return { group: OfficeAnimGroup.PHONE, room: OfficeRoom.LIBRARY };
    case "edit":
    case "other":
      return { group: OfficeAnimGroup.TYPE, room: OfficeRoom.WORK };
    case "todo":
      return { group: OfficeAnimGroup.TYPE, room: OfficeRoom.PLANNING };
    case "mcp":
      return { group: OfficeAnimGroup.TYPE, room: tool.name.startsWith(TUNELO_MCP_PREFIX) ? OfficeRoom.LOBBY : OfficeRoom.POST };
    case "shell":
      return { group: OfficeAnimGroup.MACHINE, room: classifyCommand(tool.command ?? "") };
    case "subagent":
      return ARRIVE;
  }
}
