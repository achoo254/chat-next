// The class of a shell command line, read on the machine only: the command
// itself never leaves it, only this class does. Test, lint and typecheck
// runners → check; `git commit` → commit, `git push` → push, any other git or
// GitHub CLI call → git; deploys and copies to other hosts → deploy;
// anything else → shell. What the line really runs (past `cd`, wrappers,
// `npx`, `pnpm run`, `bash -c`, `python -m`) is command-walk.ts's.
import { type CommandRules, skipOptions, walkCommand } from "./command-walk.ts";

export type CommandClass = "check" | "commit" | "push" | "git" | "deploy" | "shell";

/** Programs that check: test runners, linters, type checkers. */
export const CHECK_COMMANDS: ReadonlySet<string> = new Set(["vitest", "jest", "pytest", "eslint", "tsc", "vue-tsc", "mocha", "playwright"]);
/** `go test`, `cargo clippy`: a tool whose subcommand checks. */
const CHECK_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  go: new Set(["test", "vet"]),
  cargo: new Set(["test", "clippy", "check"]),
};
/** A script or target that checks: test, lint, typecheck and the like, also with a suffix (`test:unit`, `lint-fix`); `ci:all`. */
export const CHECK_SCRIPT = /^(test|lint|typecheck|type-check|tsc|vitest|jest|eslint)([:._-]|$)|^ci[:._-]/;
/** A program, script or target named for a deploy: `deploy`, `deploy.sh`, `deploy:web`, `infra-deploy`. */
const DEPLOY_NAME = /(^|[._:-])deploy([._:-]|$)/;
/** Programs that copy to another host. */
const COPY_COMMANDS = new Set(["rsync", "scp"]);
/** git's own options that take a value (`git -C dir commit`). */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** A script's or target's class: deploys, checks; undefined when it says neither. */
function scriptClass(name: string): CommandClass | undefined {
  const n = name.toLowerCase();
  if (DEPLOY_NAME.test(n)) return "deploy";
  if (CHECK_SCRIPT.test(n)) return "check";
  return undefined;
}

/** `git commit` → commit, `git push` → push, any other git call → git. */
function gitClass(rest: readonly string[]): CommandClass {
  const sub = rest[skipOptions(rest, 0, GIT_VALUE_FLAGS)];
  if (sub === "commit") return "commit";
  if (sub === "push") return "push";
  return "git";
}

/** A program's class by its name and the words after it; undefined for a plain shell command. */
function programClass(name: string, rest: readonly string[]): CommandClass | undefined {
  if (name === "git") return gitClass(rest);
  if (name === "gh") return "git";
  if (COPY_COMMANDS.has(name)) return "deploy";
  if (CHECK_COMMANDS.has(name)) return "check";
  const sub = CHECK_SUBCOMMANDS[name];
  if (sub) return sub.has(rest[0] ?? "") ? "check" : "shell";
  // A program or script named for a deploy (`./infra/deploy.sh prod`).
  if (DEPLOY_NAME.test(name)) return "deploy";
  return undefined;
}

const CLASS_RULES: CommandRules<CommandClass> = { program: programClass, script: scriptClass, fallback: "shell" };

/** The class of a shell command line. */
export function commandClass(command: string): CommandClass {
  return walkCommand(command, CLASS_RULES);
}
