// The words of a shell command line as the office reads them, on the machine
// only: split into simple commands (quotes respected), the setup in front of
// the real command dropped (`cd dir &&`, environment assignments, `export`,
// PowerShell's `$env:X = …;`) and the wrappers that only change how it runs
// (`env`, `sudo -u x`, `timeout 60`, `nice -n 5`, `time`). What is left is
// what the command does. docs/office-wire.md, parts 4 and 5.

/** One word: `raw` as typed (quotes kept), `text` as the shell passes it (quotes removed). */
export type ShellWord = { raw: string; text: string };

/** Separators between simple commands, longest first. */
const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "\r"];
/** Separators after which a setup command (`cd dir`) hands over to the next one; not a pipe. */
const SETUP_ENDS = new Set(["&&", ";", "\n", "\r"]);
/** Commands that only set up the place or the environment of the next one. */
const SETUP_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location", "sl", "export", "set", "setx", "source", "."]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** PowerShell's environment variables (`$env:NAME = …`). */
const PS_ENV = /^\$env:/i;

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

/**
 * Splits a command line into simple commands of words, each with the
 * separator that ended it ("" for the last). Quotes ('…', "…") keep spaces
 * and separators inside a word; a backslash escapes only a quote, a space or
 * a separator (elsewhere it is a Windows path's).
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
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      const stop = close < 0 ? line.length : close;
      raw += line.slice(i, Math.min(stop + 1, line.length));
      text += line.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length && /["'\s;&|]/.test(line[i + 1] ?? "")) {
      raw += line.slice(i, i + 2);
      text += line[i + 1] ?? "";
      inWord = true;
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
    if (/\s/.test(ch)) {
      endWord();
      i++;
      continue;
    }
    raw += ch;
    text += ch;
    inWord = true;
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

/** Drops wrappers and assignments in front of the command (`sudo -u bob env A=1 timeout 60 x` → `x …`). */
function unwrap(words: readonly ShellWord[]): ShellWord[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (!w) return [];
    if (ENV_ASSIGNMENT.test(w.text)) {
      i++;
      continue;
    }
    const wrapper = WRAPPERS[commandName(w.text)];
    if (!wrapper) return words.slice(i);
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
  }
}

/**
 * The words of the command a line runs: the first simple command that is
 * not setup (`cd dir && …`, `export A=1; …`), wrappers dropped. A setup
 * command piped into another is the command itself. [] for none.
 */
export function commandWords(line: string): ShellWord[] {
  const commands = simpleCommands(line);
  for (const [i, c] of commands.entries()) {
    const last = i === commands.length - 1;
    if (!last && SETUP_ENDS.has(c.end) && isSetup(c.words)) continue;
    return unwrap(c.words);
  }
  return [];
}

/** What a command name may look like to be shown: a plain name, nothing that could be a value. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._+-]{0,39}$/;
/** Characters that make a word a value, an expression or a quoted thing, never a command's name. */
const UNSAFE_RAW = /["'`$=()[\]{}<>@%!*?,;]/;
/** A Windows drive in front of a program's path (`C:\tools\node.exe`). */
const DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * The shell call's short subject: the command's name ("pnpm", "git") when the
 * word it starts with is plainly a program's name or path; "" otherwise, so
 * a value, a variable or anything quoted is never shown.
 */
export function shellSubject(line: string): string {
  const first = commandWords(line)[0];
  if (!first || first.raw === "&") return "";
  const raw = first.raw;
  if (UNSAFE_RAW.test(raw)) return "";
  const withoutDrive = DRIVE.test(raw) ? raw.slice(2) : raw;
  if (withoutDrive.includes(":")) return "";
  const name = commandName(withoutDrive);
  return SAFE_NAME.test(name) ? name : "";
}
