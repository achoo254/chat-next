// A shell call's subject is the command's name, never a value: whatever is
// typed in front of the command (assignments, PowerShell's $env:, `cd dir`,
// wrappers) or as a quoted value never comes out (docs/observatory-wire.md, section 4).
import { describe, expect, it } from "vitest";
import { SUBJECT_COMMANDS, commandWords, shellSubject, simpleCommands } from "../src/activity/shell-words.ts";

const MARK = "ZZMARKER-91c4-private";

describe("shell subject", () => {
  it.each([
    ["FOO=1 BAR=2 pnpm test", "pnpm"],
    ["sudo /usr/local/bin/git status", "git"],
    ["C:\\tools\\node.exe x.js", "node"],
    ["sudo -u bob git pull", "git"],
    ["timeout 60 pnpm test", "pnpm"],
    ["nice -n 10 make", "make"],
    ["time npx tsc", "npx"],
    ["env -i A=1 git status", "git"],
    ["cd apps/agent && pnpm test", "pnpm"],
    ["cd 'C:\\Program Files\\x'; git log", "git"],
    ["Git.EXE status", "git"],
    ['APP_MODE="live x" node x.js', "node"],
    ["PGPASSWORD='hunter2 x' psql", "psql"],
    ['$env:APP_MODE="x"; gh pr list', "gh"],
    ['$env:APP_MODE = "x y"; gh pr list', "gh"],
    ['cd "/w/x dir" && MODE=x make', "make"],
    ["", ""],
    ["cd x", "cd"],
  ])("%s → %s", (command, subject) => {
    expect(shellSubject(command)).toBe(subject);
  });

  it.each([
    // Values with spaces in quotes: the piece after the space is not a word of its own.
    `API_KEY="sk-live ${MARK}" node x.js`,
    `PGPASSWORD='hunter2 ${MARK}' psql`,
    `TOKEN=${MARK} gh pr list`,
    `A=1 B="x ${MARK} y" C='${MARK}' pnpm test`,
    // PowerShell's environment.
    `$env:GITHUB_TOKEN="${MARK}"; gh pr list`,
    `$env:GITHUB_TOKEN = "${MARK} two"; gh pr list`,
    `$env:A="1"; $env:B='${MARK}'; git push`,
    // cmd.exe and POSIX setup in front.
    `set TOKEN=${MARK} && git push`,
    `export TOKEN="${MARK} x" && git push`,
    `cd ${MARK} && pnpm test`,
    `cd "/home/${MARK}/repo" && FOO="${MARK}" pnpm test`,
    `pushd '${MARK} dir'; git status`,
    // Wrappers with values.
    `sudo -u ${MARK} git pull`,
    `env -u ${MARK} TOKEN=${MARK} git status`,
    `timeout -s ${MARK} 60 pnpm test`,
  ])("never shows a value: %s", (command) => {
    const s = shellSubject(command);
    expect(s.toLowerCase()).not.toContain(MARK.toLowerCase());
    expect(s).toMatch(/^[a-z0-9][a-z0-9._+-]*$|^$/);
  });

  it.each([
    `"${MARK}" --flag`,
    `'${MARK} x'`,
    `$env:TOKEN="${MARK}"`,
    `$TOKEN run`,
    `\`${MARK}\``,
    `$(cat ${MARK})`,
    `[${MARK}]::Run()`,
    `${MARK}=1`,
    `x:${MARK}`,
    `& "C:\\${MARK}\\tool.exe"`,
    // A plain name that is not on the list: not shown either (it could be anything typed first).
    "ghp_SECRET123 --help",
    "frobnicate --all",
  ])("is empty when the first word is not a listed command: %s", (command) => {
    expect(shellSubject(command)).toBe("");
  });

  it.each([
    // Substitutions, backticks and escaped quotes in an assigned value; a no-break space inside it.
    [`TOKEN=$(echo ${MARK} | base64) gh pr list`, "gh"],
    [`TOKEN=\`echo ${MARK} | base64\` gh pr list`, "gh"],
    [`X=$(printf ${MARK} ) node x.js`, "node"],
    [`X="$(echo "a ${MARK} c")" node`, "node"],
    [`X="a\\" ${MARK} q" node`, "node"],
    [`A=x\u00a0${MARK} node`, "node"],
    [`A=\u00a0${MARK} node`, "node"],
    [`X=$(echo a ${MARK}) gh`, "gh"],
    [`X=\${HOME:-${MARK}} gh`, "gh"],
    [`X=$((1 + $(echo ${MARK}))) gh`, "gh"],
    [`X=\`echo \\\` ${MARK}\` gh`, "gh"],
  ])("never shows a substituted or escaped value: %s", (command, subject) => {
    const s = shellSubject(command);
    expect(s.toLowerCase()).not.toContain(MARK.toLowerCase());
    expect(s).toBe(subject);
  });

  it("only ever gives a name from the list, whatever it is fed", () => {
    const pieces = ["A=", "$(", ")", "`", '"', "'", "\\", " ", "\u00a0", ";", "&&", "|", MARK, "git", "cd x", "$env:X=", "${", "}", "sudo -u", "\t"];
    let seed = 7;
    const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let n = 0; n < 2_000; n++) {
      const line = Array.from({ length: 1 + (next() % 10) }, () => pieces[next() % pieces.length] ?? "").join("");
      const s = shellSubject(line);
      if (s !== "") expect(SUBJECT_COMMANDS.has(s)).toBe(true);
    }
  });
});

describe("shell words", () => {
  it("keeps quoted separators and substitutions inside a word", () => {
    expect(simpleCommands(`echo "a && b"; ls`).map((c) => c.words.map((w) => w.text))).toEqual([["echo", "a && b"], ["ls"]]);
    expect(simpleCommands(`X=$(a && b | c) y; z`).map((c) => c.words.map((w) => w.raw))).toEqual([["X=$(a && b | c)", "y"], ["z"]]);
    expect(simpleCommands("X=`a; b` y").map((c) => c.words.map((w) => w.raw))).toEqual([["X=`a; b`", "y"]]);
    expect(simpleCommands(`X="a\\" b" y`).map((c) => c.words.map((w) => w.text))).toEqual([['X=a" b', "y"]]);
    expect(simpleCommands("a\u00a0b c").map((c) => c.words.map((w) => w.text))).toEqual([["a\u00a0b", "c"]]);
  });

  it("skips setup and wrappers to the real command", () => {
    expect(commandWords("cd x && sudo -u bob timeout 5 git pull").words.map((w) => w.text)).toEqual(["git", "pull"]);
    expect(commandWords("cd x").words.map((w) => w.text)).toEqual(["cd", "x"]);
  });

  it("says when a skipped word holds a substitution, a backtick or a backslash", () => {
    expect(commandWords("A=1 cd x && pnpm test").opaque).toBe(false);
    expect(commandWords("A=$(x) pnpm test").opaque).toBe(true);
    expect(commandWords("A=`x` pnpm test").opaque).toBe(true);
    expect(commandWords("cd C:\\work && pnpm test").opaque).toBe(true);
    expect(commandWords("pnpm test $(x)").opaque).toBe(false);
  });
});
