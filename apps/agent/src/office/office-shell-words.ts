// The words of a shell command line as the office reads them, on the machine
// only: split into simple commands (quotes and substitutions respected), the
// setup in front of the real command dropped (`cd dir &&`, environment
// assignments, `export`, PowerShell's `$env:X = …;`) and the wrappers that
// only change how it runs (`env`, `sudo -u x`, `timeout 60`, `nice -n 5`,
// `time`). What is left is what the command does. docs/office-wire.md,
// parts 4 and 5.
//
// The parse only picks a room (an enum) and checks a word against a fixed
// list of command names: a misparse may misroute, but the only text that
// ever leaves the machine is a name from that list (SUBJECT_COMMANDS).

/** One word: `raw` as typed (quotes kept), `text` as the shell passes it (quotes removed, substitutions kept as typed). */
export type ShellWord = { raw: string; text: string };

/**
 * The only shell subjects there are: common command names, lower case,
 * without a Windows program suffix. Anything else shows no subject.
 */
export const SUBJECT_COMMANDS: ReadonlySet<string> = new Set([
  // version control and hosting
  "git", "gh", "glab",
  // JavaScript and TypeScript
  "node", "deno", "bun", "bunx", "npm", "npx", "pnpm", "pnpx", "yarn", "tsx", "tsc", "eslint", "prettier", "biome", "vitest", "jest", "mocha", "playwright",
  // Python
  "python", "python3", "py", "pip", "pip3", "pipx", "uv", "poetry", "pytest", "ruff", "mypy",
  // other languages and builds
  "go", "cargo", "rustc", "rustup", "make", "cmake", "just", "java", "javac", "gradle", "mvn", "dotnet", "swift", "xcodebuild", "flutter", "dart", "ruby", "bundle", "php", "composer",
  // containers, cloud, infrastructure
  "docker", "docker-compose", "podman", "kubectl", "helm", "terraform", "ansible", "aws", "gcloud", "az", "wrangler", "vercel", "firebase",
  // data
  "buf", "protoc", "psql", "mysql", "mongosh", "redis-cli", "sqlite3",
  // files, text, network
  "ls", "dir", "cat", "head", "tail", "less", "grep", "rg", "find", "fd", "sed", "awk", "sort", "wc", "diff", "cp", "mv", "rm", "mkdir", "touch", "chmod", "tar", "unzip", "zip",
  "echo", "printf", "curl", "wget", "ssh", "scp", "rsync", "cd", "pushd", "which", "where", "sleep", "ps", "kill",
  // shells
  "bash", "sh", "zsh", "pwsh", "powershell", "cmd",
  // PowerShell's common commands
  "get-childitem", "get-content", "select-string", "set-location", "test-path", "remove-item", "copy-item", "new-item", "invoke-webrequest",
]);

/** Separators between simple commands, longest first. */
const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "\r"];
/** Separators after which a setup command (`cd dir`) hands over to the next one; not a pipe. */
const SETUP_ENDS = new Set(["&&", ";", "\n", "\r"]);
/** Commands that only set up the place or the environment of the next one. */
const SETUP_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location", "sl", "export", "set", "setx", "source", "."]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** PowerShell's environment variables (`$env:NAME = …`). */
const PS_ENV = /^\$env:/i;
/** What makes a skipped word untrustworthy to parse past: a substitution, a backtick, an escape. */
const OPAQUE = /\$\(|\$\{|`|\\/;
/** Word separators: ASCII space and tab only, as the shell (a no-break space is part of a word). */
const BLANK = /[ \t]/;

/** Wrappers and the options of each that take a value (`sudo -u bob`). */
const WRAPPERS: Record<string, { valueFlags: ReadonlySet<string>; takesArgument?: boolean }> = {
  env: { valueFlags: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]) },
  sudo: { valueFlags: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-h", "--host", "-p", "--prompt", "-U", "--other-user", "-r", "--role", "-t", "--type", "-D", "--chdir", "-T", "--command-timeout"]) },
  doas: { valueFlags: new Set(["-u", "-C"]) },
  // `timeout [options] DURATION command`
  timeout: { valueFlags: new Set(["-s", "--signal", "-k", "--kill-after"]), takesArgument: true },
  nice: { valueFlags: new Set(["-n", "--adjustment"]) },
  time: { valueFlags: new Set(["-o", "--output", "-f", "--format"]) },
  nohup: { valueFlags: new Set() },
  exec: { valueFlags: new Set(["-a"]) },
  command: { valueFlags: new Set() },
  // PowerShell's call operator: `& "C:\tools\x.exe" args`.
  "&": { valueFlags: new Set() },
};

/** A word as a command name: the file name, lower case, without a Windows program suffix. */
export function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

/** Whether a word names a command on the subject list. */
export function isListedCommand(word: string): boolean {
  return SUBJECT_COMMANDS.has(commandName(word));
}

/** The index after a `$(…)`, `$((…))` or `${…}` starting at `i` (nesting, quotes and backticks inside respected); the line's end when unclosed. */
function skipSubstitution(line: string, i: number): number {
  const open = line[i + 1] === "{" ? "{" : "(";
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  let j = i + 1;
  while (j < line.length) {
    const ch = line[j] ?? "";
    if (ch === "\\") j += 2;
    else if (ch === "'") j = skipSingle(line, j);
    else if (ch === '"') j = skipDouble(line, j);
    else if (ch === "`") j = skipBacktick(line, j);
    else if (ch === "$" && (line[j + 1] === "(" || line[j + 1] === "{")) j = skipSubstitution(line, j);
    else {
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return j + 1;
      j++;
    }
  }
  return line.length;
}

/** The index after a `'…'` starting at `i`. */
function skipSingle(line: string, i: number): number {
  const close = line.indexOf("'", i + 1);
  return close < 0 ? line.length : close + 1;
}

/** The index after a `` `…` `` starting at `i` (`\`` inside does not close it). */
function skipBacktick(line: string, i: number): number {
  let j = i + 1;
  while (j < line.length) {
    const ch = line[j];
    if (ch === "\\") j += 2;
    else if (ch === "`") return j + 1;
    else j++;
  }
  return line.length;
}

/** The index after a `"…"` starting at `i`: `\"`, `\\`, `` \` ``, `\$` do not close it, nor do substitutions inside. */
function skipDouble(line: string, i: number): number {
  let j = i + 1;
  while (j < line.length) {
    const ch = line[j] ?? "";
    if (ch === "\\") j += 2;
    else if (ch === '"') return j + 1;
    else if (ch === "`") j = skipBacktick(line, j);
    else if (ch === "$" && (line[j + 1] === "(" || line[j + 1] === "{")) j = skipSubstitution(line, j);
    else j++;
  }
  return line.length;
}

/** What the shell passes for a `"…"` block: its content, the escapes of `"`, `\`, `` ` ``, `$` undone. */
function doubleText(block: string): string {
  const inner = block.endsWith('"') && block.length > 1 ? block.slice(1, -1) : block.slice(1);
  return inner.replace(/\\(["\\`$])/g, "$1");
}

/**
 * Splits a command line into simple commands of words, each with the
 * separator that ended it ("" for the last). Quotes, `$(…)`, `${…}` and
 * backticks keep spaces and separators inside one word; a backslash outside
 * quotes escapes only a quote, a blank, a separator, `$` or a backtick
 * (elsewhere it is a Windows path's). Only ASCII space and tab part words.
 */
export function simpleCommands(line: string): { words: ShellWord[]; end: string }[] {
  const out: { words: ShellWord[]; end: string }[] = [];
  let words: ShellWord[] = [];
  let raw = "";
  let text = "";
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push({ raw, text });
    raw = "";
    text = "";
    inWord = false;
  };
  const endCommand = (sep: string): void => {
    endWord();
    if (words.length > 0) out.push({ words, end: sep });
    words = [];
  };
  const block = (from: number, to: number, shown: string): void => {
    raw += line.slice(from, to);
    text += shown;
    inWord = true;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "'") {
      const to = skipSingle(line, i);
      block(i, to, line.slice(i + 1, line[to - 1] === "'" && to - 1 > i ? to - 1 : to));
      i = to;
      continue;
    }
    if (ch === '"') {
      const to = skipDouble(line, i);
      block(i, to, doubleText(line.slice(i, to)));
      i = to;
      continue;
    }
    if (ch === "`") {
      const to = skipBacktick(line, i);
      block(i, to, line.slice(i, to));
      i = to;
      continue;
    }
    if (ch === "$" && (line[i + 1] === "(" || line[i + 1] === "{")) {
      const to = skipSubstitution(line, i);
      block(i, to, line.slice(i, to));
      i = to;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length && /["' \t\n;&|$`]/.test(line[i + 1] ?? "")) {
      block(i, i + 2, line[i + 1] ?? "");
      i += 2;
      continue;
    }
    const sep = SEPARATORS.find((s) => line.startsWith(s, i));
    // `&` right before a word is PowerShell's call operator, not a separator, when it starts a command.
    if (sep === "&" && !inWord && words.length === 0) {
      words.push({ raw: "&", text: "&" });
      i++;
      continue;
    }
    if (sep) {
      endCommand(sep);
      i += sep.length;
      continue;
    }
    if (BLANK.test(ch)) {
      endWord();
      i++;
      continue;
    }
    block(i, i + 1, ch);
    i++;
  }
  endCommand("");
  return out;
}

/** A simple command that only sets up the next one: `cd dir`, `export A=1`, only assignments, `$env:A = "1"`. */
function isSetup(words: readonly ShellWord[]): boolean {
  const first = words[0];
  if (!first) return true;
  if (PS_ENV.test(first.text)) return true;
  if (words.every((w) => ENV_ASSIGNMENT.test(w.text))) return true;
  return SETUP_COMMANDS.has(commandName(first.text));
}

/** Drops wrappers and assignments in front of the command (`sudo -u bob env A=1 timeout 60 x` → `x …`); `skipped` gets the words dropped. */
function unwrap(words: readonly ShellWord[], skipped: ShellWord[]): ShellWord[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (!w) return [];
    if (ENV_ASSIGNMENT.test(w.text)) {
      skipped.push(w);
      i++;
      continue;
    }
    const wrapper = WRAPPERS[commandName(w.text)];
    if (!wrapper) return words.slice(i);
    const from = i;
    i++;
    // The wrapper's own options: `--` ends them; `-n 5` takes a value, `-n5` and `--x=y` do not.
    while (i < words.length) {
      const opt = words[i]?.text ?? "";
      if (opt === "--") {
        i++;
        break;
      }
      if (!opt.startsWith("-") || opt === "-") break;
      i += wrapper.valueFlags.has(opt) ? 2 : 1;
    }
    // `timeout 60 x`: its duration; `nice -10 x` is an option above.
    if (wrapper.takesArgument && i < words.length) i++;
    skipped.push(...words.slice(from, i));
  }
}

/**
 * The words of the command a line runs: the first simple command that is
 * not setup (`cd dir && …`, `export A=1; …`), wrappers dropped. A setup
 * command piped into another is the command itself. `opaque`: a word skipped
 * on the way holds a substitution, a backtick or a backslash, so what
 * follows it may not be what the shell runs.
 */
export function commandWords(line: string): { words: ShellWord[]; opaque: boolean } {
  const commands = simpleCommands(line);
  const skipped: ShellWord[] = [];
  for (const [i, c] of commands.entries()) {
    const last = i === commands.length - 1;
    if (!last && SETUP_ENDS.has(c.end) && isSetup(c.words)) {
      skipped.push(...c.words);
      continue;
    }
    const words = unwrap(c.words, skipped);
    return { words, opaque: skipped.some((w) => OPAQUE.test(w.raw)) };
  }
  return { words: [], opaque: skipped.some((w) => OPAQUE.test(w.raw)) };
}

/**
 * The shell call's short subject: the command's name ("pnpm", "git") when it
 * is on SUBJECT_COMMANDS; "" otherwise. Whatever the parse makes of a line,
 * nothing but a name from that list comes out.
 */
export function shellSubject(line: string): string {
  const first = commandWords(line).words[0];
  if (!first) return "";
  const name = commandName(first.text);
  return SUBJECT_COMMANDS.has(name) ? name : "";
}
