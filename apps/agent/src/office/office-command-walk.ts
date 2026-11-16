// How the office reads what a shell command line really runs, on the machine
// only (docs/office-wire.md, part 4): past setup and wrappers
// (office-shell-words.ts), through runners (`npx x`), package managers
// (`pnpm --filter app run dev`, `pnpm exec vitest`), make-like tools
// (`make test`), shells given a string (`bash -c "…"`) and interpreters
// (`python -m pytest`, `uv run x`, `node node_modules/vitest/vitest.mjs`), to
// the program or the script name at the end. A caller's rules turn that into
// its own answer (a room, a service kind); the walk itself returns only what
// the rules return, never a word of the command.
import { commandName, commandWords, isListedCommand } from "./office-shell-words.ts";

/** What a caller makes of the program or script a command runs. */
export interface CommandRules<R> {
  /** A program by its command name (`commandName`) and the words after it; undefined when it says nothing. */
  program(name: string, rest: readonly string[]): R | undefined;
  /** A package script or make target by its name as typed; undefined when it says nothing. */
  script(name: string): R | undefined;
  /** The answer when neither says anything, or the line cannot be trusted. */
  readonly fallback: R;
}

/** Programs that run something written in front of them (`npx vitest`). */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** A runner's options that take a value (`npx -p pkg vitest`). */
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);
/** Shells that run a command given as a string (`bash -c "pnpm test"`). */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell", "cmd"]);
const SHELL_STRING_FLAGS = new Set(["-c", "-command", "/c", "/k"]);
const SHELL_VALUE_FLAGS = new Set(["-o", "-O", "+O", "--rcfile", "--init-file"]);
/** Interpreters whose own runner may start another program (`python -m pytest`, `uv run pytest`). */
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
export function skipOptions(words: readonly string[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += valueFlags.has(w) ? 2 : 1;
  }
  return i;
}

/** One walk: the rules, and how many `bash -c "…"` strings may still be opened. */
class Walk<R> {
  constructor(private readonly rules: CommandRules<R>) {}

  line(line: string, depth: number): R {
    const { words, opaque } = commandWords(line);
    const texts = words.map((w) => w.text);
    if (texts.length === 0) return this.rules.fallback;
    // Past a substitution, a backtick or an escape the parse may be off: trust only a command on the known list.
    if (opaque && !isListedCommand(texts[0] ?? "")) return this.rules.fallback;
    return this.program(texts, depth);
  }

  /** A program and the words after it. */
  program(words: readonly string[], depth: number): R {
    const head = commandName(words[0] ?? "");
    const rest = words.slice(1);
    if (RUNNERS.has(head)) {
      const next = rest.slice(skipOptions(rest, 0, RUNNER_VALUE_FLAGS));
      return next.length > 0 ? this.program(next, depth) : this.rules.fallback;
    }
    const pmFlags = PACKAGE_MANAGERS[head];
    if (pmFlags) return this.packageManager(head, rest, pmFlags, depth);
    if (MAKES.has(head)) {
      const target = rest[skipOptions(rest, 0, MAKE_VALUE_FLAGS)];
      return (target === undefined ? undefined : this.rules.script(target)) ?? this.rules.program(head, rest) ?? this.rules.fallback;
    }
    if (SHELLS.has(head)) return this.shell(rest, depth);
    if (INTERPRETERS.has(head)) return this.interpreter(head, rest, depth);
    return this.rules.program(head, rest) ?? this.rules.fallback;
  }

  /** `pnpm --filter x test`, `npm run -w app lint`, `yarn workspace app test`, `pnpm exec vitest`, `pnpm deploy`. */
  private packageManager(pm: string, words: readonly string[], valueFlags: ReadonlySet<string>, depth: number): R {
    let i = skipOptions(words, 0, valueFlags);
    // `yarn workspace <name> <script>`
    if (pm === "yarn" && words[i] === "workspace") i = skipOptions(words, i + 2, valueFlags);
    const sub = words[i] ?? "";
    if (RUN_PROGRAM.has(sub)) {
      const rest = words.slice(skipOptions(words, i + 1, valueFlags));
      return rest.length > 0 ? this.program(rest, depth) : this.rules.fallback;
    }
    if (RUN_SCRIPT.has(sub)) {
      const script = words[skipOptions(words, i + 1, valueFlags)];
      return (script === undefined ? undefined : this.rules.script(script)) ?? this.rules.fallback;
    }
    // A built-in (`pnpm deploy`, `npm test`) or a script run without `run` (`pnpm lint`, `yarn dev`).
    return this.rules.script(sub) ?? this.rules.fallback;
  }

  /** `bash -c "pnpm test"` is that command; `bash ./deploy.sh` is that script as a program. */
  private shell(words: readonly string[], depth: number): R {
    const flag = words.findIndex((w) => SHELL_STRING_FLAGS.has(w.toLowerCase()));
    if (flag >= 0) return depth > 0 ? this.line(words.slice(flag + 1).join(" "), depth - 1) : this.rules.fallback;
    const at = skipOptions(words, 0, SHELL_VALUE_FLAGS);
    const script = words[at];
    if (script === undefined) return this.rules.fallback;
    return this.rules.program(commandName(script), words.slice(at + 1)) ?? this.rules.fallback;
  }

  /** `python -m pytest`, `uv run pytest`, `poetry run pytest`, `node node_modules/vitest/vitest.mjs`. */
  private interpreter(head: string, words: readonly string[], depth: number): R {
    if (head === "python" || head === "python3" || head === "py") {
      const m = words.indexOf("-m");
      return m >= 0 && words[m + 1] !== undefined ? this.program(words.slice(m + 1), depth) : this.rules.fallback;
    }
    if (head === "node") {
      const at = skipOptions(words, 0, new Set(["-r", "--require", "--import", "--loader"]));
      const script = words[at];
      if (script === undefined) return this.rules.fallback;
      return this.program([commandName(script).replace(/\.(m?js|cjs|ts)$/, ""), ...words.slice(at + 1)], depth);
    }
    // uv, poetry, pipenv, hatch, pdm: `run <program>`.
    const run = skipOptions(words, 0, new Set(["--directory", "--project", "-C"]));
    if (words[run] !== "run") return this.rules.fallback;
    const rest = words.slice(skipOptions(words, run + 1, new Set(["--with", "--python", "-p"])));
    return rest.length > 0 ? this.program(rest, depth) : this.rules.fallback;
  }
}

/** What `rules` make of the program or script a shell command line runs; two nested `bash -c` strings at most. */
export function walkCommand<R>(command: string, rules: CommandRules<R>): R {
  return new Walk(rules).line(command, 2);
}
