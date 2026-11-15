// The room of a shell command (docs/office-wire.md, part 4): read on the
// machine only, to pick one of three rooms; the command itself never
// leaves it. Git, deploys and copies to other hosts → POST; test, lint and
// typecheck runners → QA; anything else → SERVER.
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { commandName, commandWords, isListedCommand } from "./office-shell-words.ts";

const POST_COMMANDS = new Set(["git", "gh", "rsync", "scp"]);
const QA_COMMANDS = new Set(["vitest", "jest", "pytest", "eslint", "tsc", "vue-tsc", "mocha", "playwright"]);
/** `go test`, `cargo clippy`: a tool whose subcommand checks. */
const QA_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  go: new Set(["test", "vet"]),
  cargo: new Set(["test", "clippy", "check"]),
};
/** A script or target that checks: test, lint, typecheck and the like, also with a suffix (`test:unit`, `lint-fix`); `ci:all`. */
const QA_SCRIPT = /^(test|lint|typecheck|type-check|tsc|vitest|jest|eslint)([:._-]|$)|^ci[:._-]/;
/** A program, script or target named for a deploy: `deploy`, `deploy.sh`, `deploy:web`, `infra-deploy`. */
const DEPLOY_NAME = /(^|[._:-])deploy([._:-]|$)/;
/** Programs that run something written in front of them (`npx vitest`). */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** A runner's options that take a value (`npx -p pkg vitest`). */
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);
/** Shells that run a command given as a string (`bash -c "pnpm test"`). */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell", "cmd"]);
const SHELL_STRING_FLAGS = new Set(["-c", "-command", "/c", "/k"]);
/** Interpreters whose own runner may start a checker (`python -m pytest`, `uv run pytest`). */
const INTERPRETERS = new Set(["python", "python3", "py", "node", "uv", "poetry", "pipenv", "hatch", "pdm"]);
const MAKES = new Set(["make", "gmake", "just", "task"]);
const MAKE_VALUE_FLAGS = new Set(["-C", "--directory", "-f", "--file", "--makefile", "-j", "--jobs", "-I", "--include-dir", "-o", "-W", "-d"]);

/** Package managers and their options that take a value; any other option stands alone (`pnpm -w`, `pnpm -r`). */
const PACKAGE_MANAGERS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set(["--filter", "-F", "-C", "--dir", "--workspace-dir", "--reporter", "--loglevel", "--test-pattern", "--changed-files-ignore-pattern"]),
  npm: new Set(["-w", "--workspace", "--prefix", "-C", "--loglevel", "--userconfig", "--registry"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "-F", "--filter", "-c", "--config"]),
};
/** A package manager's word that runs a script by name next. */
const RUN_SCRIPT = new Set(["run", "run-script", "rum", "urn"]);
/** A package manager's word that runs a program next (`pnpm exec vitest`). */
const RUN_PROGRAM = new Set(["exec", "x", "dlx"]);

/** Index of the first word at or after `from` that is not an option; `valueFlags` take the next word too. */
function skipOptions(words: readonly string[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += valueFlags.has(w) ? 2 : 1;
  }
  return i;
}

/** A script's or target's room: deploys go out, checks to QA; undefined when it says neither. */
function scriptRoom(name: string): OfficeRoom | undefined {
  const n = name.toLowerCase();
  if (DEPLOY_NAME.test(n)) return OfficeRoom.POST;
  if (QA_SCRIPT.test(n)) return OfficeRoom.QA;
  return undefined;
}

/** A program's room by its name and the words after it. */
function programRoom(words: readonly string[], depth: number): OfficeRoom {
  const head = commandName(words[0] ?? "");
  const rest = words.slice(1);
  if (POST_COMMANDS.has(head)) return OfficeRoom.POST;
  if (QA_COMMANDS.has(head)) return OfficeRoom.QA;
  const sub = QA_SUBCOMMANDS[head];
  if (sub) return sub.has(rest[0] ?? "") ? OfficeRoom.QA : OfficeRoom.SERVER;
  if (RUNNERS.has(head)) return programRoom(rest.slice(skipOptions(rest, 0, RUNNER_VALUE_FLAGS)), depth);
  const pmFlags = PACKAGE_MANAGERS[head];
  if (pmFlags) return packageRoom(head, rest, pmFlags, depth);
  if (MAKES.has(head)) {
    const target = rest[skipOptions(rest, 0, MAKE_VALUE_FLAGS)];
    return target === undefined ? OfficeRoom.SERVER : (scriptRoom(target) ?? OfficeRoom.SERVER);
  }
  if (SHELLS.has(head)) return shellRoom(rest, depth);
  if (INTERPRETERS.has(head)) return interpreterRoom(head, rest, depth);
  // A program or script named for a deploy (`./infra/deploy.sh prod`).
  if (DEPLOY_NAME.test(head)) return OfficeRoom.POST;
  return OfficeRoom.SERVER;
}

/** `pnpm --filter x test`, `npm run -w app lint`, `yarn workspace app test`, `pnpm exec vitest`, `pnpm deploy`. */
function packageRoom(pm: string, words: readonly string[], valueFlags: ReadonlySet<string>, depth: number): OfficeRoom {
  let i = skipOptions(words, 0, valueFlags);
  // `yarn workspace <name> <script>`
  if (pm === "yarn" && words[i] === "workspace") i = skipOptions(words, i + 2, valueFlags);
  const sub = words[i] ?? "";
  if (RUN_PROGRAM.has(sub)) {
    const rest = words.slice(skipOptions(words, i + 1, valueFlags));
    return rest.length > 0 ? programRoom(rest, depth) : OfficeRoom.SERVER;
  }
  if (RUN_SCRIPT.has(sub)) {
    const script = words[skipOptions(words, i + 1, valueFlags)];
    return script === undefined ? OfficeRoom.SERVER : (scriptRoom(script) ?? OfficeRoom.SERVER);
  }
  // A built-in (`pnpm deploy`, `npm test`) or a script run without `run` (`pnpm lint`, `yarn test`).
  return scriptRoom(sub) ?? OfficeRoom.SERVER;
}

/** `bash -c "pnpm test"` is that command; `bash ./deploy.sh` is that script. */
function shellRoom(words: readonly string[], depth: number): OfficeRoom {
  const flag = words.findIndex((w) => SHELL_STRING_FLAGS.has(w.toLowerCase()));
  if (flag >= 0) {
    const inner = words.slice(flag + 1).join(" ");
    return depth > 0 ? classifyLine(inner, depth - 1) : OfficeRoom.SERVER;
  }
  const script = words[skipOptions(words, 0, new Set(["-o", "-O", "+O", "--rcfile", "--init-file"]))];
  return script !== undefined && DEPLOY_NAME.test(commandName(script)) ? OfficeRoom.POST : OfficeRoom.SERVER;
}

/** `python -m pytest`, `uv run pytest`, `poetry run pytest`, `node node_modules/vitest/vitest.mjs`. */
function interpreterRoom(head: string, words: readonly string[], depth: number): OfficeRoom {
  if (head === "python" || head === "python3" || head === "py") {
    const m = words.indexOf("-m");
    return m >= 0 && words[m + 1] !== undefined ? programRoom(words.slice(m + 1), depth) : OfficeRoom.SERVER;
  }
  if (head === "node") {
    const script = words[skipOptions(words, 0, new Set(["-r", "--require", "--import", "--loader"]))];
    if (script === undefined) return OfficeRoom.SERVER;
    return programRoom([commandName(script).replace(/\.(m?js|cjs|ts)$/, "")], depth);
  }
  // uv, poetry, pipenv, hatch, pdm: `run <program>`.
  const run = skipOptions(words, 0, new Set(["--directory", "--project", "-C"]));
  if (words[run] !== "run") return OfficeRoom.SERVER;
  const rest = words.slice(skipOptions(words, run + 1, new Set(["--with", "--python", "-p"])));
  return rest.length > 0 ? programRoom(rest, depth) : OfficeRoom.SERVER;
}

function classifyLine(line: string, depth: number): OfficeRoom {
  const { words, opaque } = commandWords(line);
  const texts = words.map((w) => w.text);
  if (texts.length === 0) return OfficeRoom.SERVER;
  // Past a substitution, a backtick or an escape the parse may be off: trust only a command on the known list.
  if (opaque && !isListedCommand(texts[0] ?? "")) return OfficeRoom.SERVER;
  return programRoom(texts, depth);
}

/** The room of a shell command line. */
export function classifyCommand(command: string): OfficeRoom {
  return classifyLine(command, 2);
}
