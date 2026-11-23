// What a background shell command is, as the office labels its machine
// (docs/office-wire.md, part 4): read on the machine only, through the same
// walk as the room (activity/command-walk.ts), of the line's last command that
// says what it is (`git pull && pnpm dev` is a dev server), into one of seven kinds, plus
// the TCP port a dev server or database was told to listen on when the
// command's own words say so (`--port 5173`, `-p 3000`, `PORT=8080`). No
// system scan; only the kind's enum and the port's number leave the machine,
// never a word of the command.
import { OfficeServiceKind } from "@achoo254/chat-proto/remote/remote";
import { CHECK_COMMANDS, CHECK_SCRIPT } from "../activity/command-class.ts";
import { type CommandRules, walkCommand } from "../activity/command-walk.ts";
import { simpleCommands } from "../activity/shell-words.ts";

export type ServiceLabel = { kind: OfficeServiceKind; port: number };

const K = OfficeServiceKind;

/** Programs whose `build` builds and anything else serves (`vite`, `next dev`, `astro preview`). */
const FRAMEWORK_SERVERS = new Set(["vite", "next", "nuxt", "nuxi", "astro", "remix", "parcel", "ng", "expo", "svelte-kit", "gatsby", "react-scripts", "vue-cli-service"]);
/** Programs that only serve. */
const SERVERS = new Set([
  "webpack-dev-server", "http-server", "serve", "live-server", "browser-sync", "nodemon", "uvicorn", "gunicorn", "hypercorn", "flask", "rails",
  "json-server", "storybook", "start-storybook", "hugo", "jekyll", "http.server", "streamlit", "gradio", "caddy", "nginx", "air", "wrangler",
]);
/** Programs that build or compile. */
const BUILDERS = new Set(["tsc", "vue-tsc", "webpack", "rollup", "esbuild", "tsup", "swc", "babel", "gradle", "gradlew", "mvn", "xcodebuild", "cmake", "ninja", "msbuild", "bazel"]);
/** Database servers, clients and migration tools. */
const DATABASES = new Set([
  "postgres", "pg_ctl", "psql", "mysql", "mysqld", "mariadb", "mongod", "mongosh", "mongo", "redis-server", "redis-cli", "sqlite3", "prisma", "drizzle-kit", "supabase",
]);
/** `go`, `cargo`, `dotnet`, `deno`: by subcommand. */
const TOOLCHAINS: Record<string, Readonly<Record<string, OfficeServiceKind>>> = {
  go: { test: K.TEST_WATCH, vet: K.TEST_WATCH, build: K.BUILD, install: K.BUILD, run: K.DEV_SERVER },
  cargo: { test: K.TEST_WATCH, clippy: K.TEST_WATCH, check: K.TEST_WATCH, build: K.BUILD, run: K.DEV_SERVER, watch: K.BUILD },
  dotnet: { test: K.TEST_WATCH, build: K.BUILD, run: K.DEV_SERVER, watch: K.DEV_SERVER },
  deno: { test: K.TEST_WATCH, lint: K.TEST_WATCH, check: K.TEST_WATCH, compile: K.BUILD, run: K.DEV_SERVER, serve: K.DEV_SERVER },
};

/** A package script or make target that serves (`dev`, `start:web`, `serve`, `preview`). */
const DEV_SCRIPT = /^(dev|start|serve|server|preview|storybook)([:._-]|$)/;
const BUILD_SCRIPT = /^(build|compile|bundle|watch)([:._-]|$)/;
const DATABASE_SCRIPT = /^(db|database|migrate|migration|prisma|seed)([:._-]|$)/;
/** A program or script file named for what it does (`./dev.sh`, `node server.js`, `./scripts/build.sh`). */
const DEV_NAME = /(^|[._-])(dev|serve|server)([._-]|$)/;
const BUILD_NAME = /(^|[._-])(build|compile|bundle)([._-]|$)/;
const TEST_NAME = /(^|[._-])(test|tests|e2e|spec)([._-]|$)/;

function scriptKind(name: string): OfficeServiceKind | undefined {
  const n = name.toLowerCase();
  if (DEV_SCRIPT.test(n)) return K.DEV_SERVER;
  if (CHECK_SCRIPT.test(n)) return K.TEST_WATCH;
  if (BUILD_SCRIPT.test(n)) return K.BUILD;
  if (DATABASE_SCRIPT.test(n)) return K.DATABASE;
  return undefined;
}

function programKind(name: string, rest: readonly string[]): OfficeServiceKind | undefined {
  const sub = rest.find((w) => !w.startsWith("-")) ?? "";
  if (name === "gh") return rest.includes("watch") || rest.includes("--watch") ? K.CI_WATCH : K.GIT;
  if (name === "glab") return sub === "ci" ? K.CI_WATCH : K.GIT;
  if (name === "git" || name === "git-lfs") return K.GIT;
  if (BUILDERS.has(name)) return name === "webpack" && sub === "serve" ? K.DEV_SERVER : K.BUILD;
  if (CHECK_COMMANDS.has(name)) return K.TEST_WATCH;
  if (DATABASES.has(name)) return K.DATABASE;
  if (FRAMEWORK_SERVERS.has(name)) {
    if (sub === "build" || sub === "export") return K.BUILD;
    return sub === "test" || sub === "lint" ? K.TEST_WATCH : K.DEV_SERVER;
  }
  if (SERVERS.has(name)) return K.DEV_SERVER;
  const toolchain = TOOLCHAINS[name];
  if (toolchain) return toolchain[sub] ?? (name === "deno" && sub === "task" ? scriptKind(rest[rest.indexOf("task") + 1] ?? "") : undefined);
  if (name === "turbo" || name === "nx") return scriptKind(rest.filter((w) => !w.startsWith("-") && w !== "run")[0] ?? "");
  if (name === "docker" || name === "podman" || name === "docker-compose") {
    if (sub === "build") return K.BUILD;
    return rest.includes("up") || sub === "run" || sub === "start" ? K.DEV_SERVER : undefined;
  }
  // `php artisan serve`, `rails server`, `python -m http.server` come through above; a file named for its work last.
  if (name === "php" && rest.includes("serve")) return K.DEV_SERVER;
  if (DEV_NAME.test(name)) return K.DEV_SERVER;
  if (TEST_NAME.test(name)) return K.TEST_WATCH;
  if (BUILD_NAME.test(name)) return K.BUILD;
  return undefined;
}

const SERVICE_RULES: CommandRules<OfficeServiceKind> = { program: programKind, script: scriptKind, fallback: K.SCRIPT };

/** A port as typed: a whole number 1 to 65535, or the host side of `8080:80`; 0 otherwise. */
function portOf(value: string): number {
  const m = /^(\d{1,5})(?::\d{1,5})?$/.exec(value);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 65_535 ? n : 0;
}

/** `PORT=8080`, `VITE_PORT=5173` in front of a command. */
const PORT_ASSIGNMENT = /^(?:[A-Z][A-Z0-9_]*_)?PORT=(.+)$/;
/** Long options that name the port, for any program. */
const PORT_FLAGS: ReadonlySet<string> = new Set(["--port", "--http-port"]);
/** Programs whose `-p` names the port (elsewhere `-p` means something else: `mysql -p` is the password, `ssh -p` a remote port). */
const SHORT_P_PORT: ReadonlySet<string> = new Set([
  "next", "vite", "http-server", "json-server", "flask", "rails", "hugo", "docker", "podman", "docker-compose", "postgres", "psql", "pg_ctl", "streamlit",
]);
/** Programs whose `-P` names the port. */
const CAPITAL_P_PORT: ReadonlySet<string> = new Set(["mysql", "mysqld", "mariadb"]);

/** The flags that name the port of `program` (the name the command line ends up running). */
function portFlags(program: string): ReadonlySet<string> {
  if (SHORT_P_PORT.has(program)) return new Set([...PORT_FLAGS, "-p"]);
  if (CAPITAL_P_PORT.has(program)) return new Set([...PORT_FLAGS, "-P"]);
  return PORT_FLAGS;
}

/** The program a command line ends up running by name ("" for a package script or when unsure), to know its port flags. */
const PROGRAM_NAME: CommandRules<string> = { program: (name) => name, script: () => "", fallback: "" };

/** The first port the words give, looking once inside a string a shell runs (`bash -c "vite --port 5173"`); 0 when none. */
function portInWords(words: readonly string[], flags: ReadonlySet<string>, nested: boolean): number {
  for (const [i, w] of words.entries()) {
    const assigned = PORT_ASSIGNMENT.exec(w)?.[1];
    if (assigned !== undefined && portOf(assigned) > 0) return portOf(assigned);
    if (flags.has(w) && portOf(words[i + 1] ?? "") > 0) return portOf(words[i + 1] ?? "");
    const eq = /^--(?:http-)?port=(.+)$/.exec(w)?.[1];
    if (eq !== undefined && portOf(eq) > 0) return portOf(eq);
    if (!nested && /[ \t]/.test(w)) {
      const inner = portInLine(w, flags, true);
      if (inner > 0) return inner;
    }
  }
  return 0;
}

function portInLine(line: string, flags: ReadonlySet<string>, nested: boolean): number {
  for (const c of simpleCommands(line)) {
    const port = portInWords(
      c.words.map((w) => w.text),
      flags,
      nested,
    );
    if (port > 0) return port;
  }
  return 0;
}

/** `raw` without the opener of a group at its start (`(nc` is `nc`, `{` is nothing). */
const withoutOpener = (raw: string): string => raw.replace(/^[({]+/, "");

/** `raw` without the closer of a group at its end (`5173)` is `5173`); a pair inside the word (`$(date)`, `${PORT}`) stays. */
function withoutCloser(raw: string): string {
  const count = (word: string, ch: string): number => word.split(ch).length - 1;
  let word = raw;
  while ((word.endsWith(")") && count(word, "(") < count(word, ")")) || (word.endsWith("}") && count(word, "{") < count(word, "}"))) word = word.slice(0, -1);
  return word;
}

/** The simple commands of a line as lines of their own, as typed, with the grouping of a subshell or brace group taken off. */
function chainParts(command: string): string[] {
  return simpleCommands(command)
    .map(({ words }) => {
      const raws = words.map((w) => w.raw);
      raws[0] = withoutOpener(raws[0] ?? "");
      raws[raws.length - 1] = withoutCloser(raws[raws.length - 1] ?? "");
      return raws.filter((w) => w !== "").join(" ");
    })
    .filter((part) => part !== "");
}

/**
 * The command of a chain that is the service: the last one that says what it is. Whatever comes before runs first
 * and is preparation (`git pull && pnpm dev`, `nc -z host 5173 || vite --port 5173`, `pkill x; PORT=5173 serve`), and
 * whatever comes after only looks at it (`pnpm dev | tee log`, `serve & sleep 2; curl localhost`). A line none of
 * whose commands says anything has none.
 */
function mainCommand(parts: readonly string[]): { line: string; kind: OfficeServiceKind } | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const line = parts[i] ?? "";
    const kind = walkCommand(line, SERVICE_RULES);
    if (kind !== K.SCRIPT) return { line, kind };
  }
  return undefined;
}

/**
 * The label of a background shell command: its kind and, for a dev server or
 * a database, the port its words name (0 when they name none): `--port`
 * for any program, `-p` only where it means the port (`next -p`, `docker -p`,
 * `psql -p`; never `mysql -p`, the password), `-P` for MySQL. A port in
 * another kind of command (`ssh -p 22`, `mkdir -p`) is never read.
 */
export function classifyService(command: string): ServiceLabel {
  const parts = chainParts(command);
  const main = mainCommand(parts);
  if (main === undefined || (main.kind !== K.DEV_SERVER && main.kind !== K.DATABASE)) return { kind: main?.kind ?? K.SCRIPT, port: 0 };
  // The port may stand in a command of the chain before the service (`export PORT=3000; vite`), read with the service's own flags.
  const flags = portFlags(walkCommand(main.line, PROGRAM_NAME));
  for (const part of parts) {
    const port = portInLine(part, flags, false);
    if (port > 0) return { kind: main.kind, port };
  }
  return { kind: main.kind, port: 0 };
}
