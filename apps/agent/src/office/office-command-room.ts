// The room of a shell command (docs/office-wire.md, part 4): read on the
// machine only, to pick one of three rooms; the command itself never
// leaves it. Git, deploys and copies to other hosts → POST; test, lint and
// typecheck runners → QA; anything else → SERVER. What the line really runs
// (past `cd`, wrappers, `npx`, `pnpm run`, `bash -c`, `python -m`) is
// office-command-walk.ts's.
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { type CommandRules, walkCommand } from "./office-command-walk.ts";

const POST_COMMANDS = new Set(["git", "gh", "rsync", "scp"]);
/** Programs that check: test runners, linters, type checkers. */
export const CHECK_COMMANDS: ReadonlySet<string> = new Set(["vitest", "jest", "pytest", "eslint", "tsc", "vue-tsc", "mocha", "playwright"]);
/** `go test`, `cargo clippy`: a tool whose subcommand checks. */
const QA_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  go: new Set(["test", "vet"]),
  cargo: new Set(["test", "clippy", "check"]),
};
/** A script or target that checks: test, lint, typecheck and the like, also with a suffix (`test:unit`, `lint-fix`); `ci:all`. */
export const CHECK_SCRIPT = /^(test|lint|typecheck|type-check|tsc|vitest|jest|eslint)([:._-]|$)|^ci[:._-]/;
/** A program, script or target named for a deploy: `deploy`, `deploy.sh`, `deploy:web`, `infra-deploy`. */
const DEPLOY_NAME = /(^|[._:-])deploy([._:-]|$)/;

/** A script's or target's room: deploys go out, checks to QA; undefined when it says neither. */
function scriptRoom(name: string): OfficeRoom | undefined {
  const n = name.toLowerCase();
  if (DEPLOY_NAME.test(n)) return OfficeRoom.POST;
  if (CHECK_SCRIPT.test(n)) return OfficeRoom.QA;
  return undefined;
}

/** A program's room by its name and the words after it; undefined for the server room. */
function programRoom(name: string, rest: readonly string[]): OfficeRoom | undefined {
  if (POST_COMMANDS.has(name)) return OfficeRoom.POST;
  if (CHECK_COMMANDS.has(name)) return OfficeRoom.QA;
  const sub = QA_SUBCOMMANDS[name];
  if (sub) return sub.has(rest[0] ?? "") ? OfficeRoom.QA : OfficeRoom.SERVER;
  // A program or script named for a deploy (`./infra/deploy.sh prod`).
  if (DEPLOY_NAME.test(name)) return OfficeRoom.POST;
  return undefined;
}

const ROOM_RULES: CommandRules<OfficeRoom> = { program: programRoom, script: scriptRoom, fallback: OfficeRoom.SERVER };

/** The room of a shell command line. */
export function classifyCommand(command: string): OfficeRoom {
  return walkCommand(command, ROOM_RULES);
}
