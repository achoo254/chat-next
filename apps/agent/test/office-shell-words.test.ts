// A shell call's subject is the command's name, never a value: whatever is
// typed in front of the command (assignments, PowerShell's $env:, `cd dir`,
// wrappers) or as a quoted value never comes out (docs/office-wire.md, part 5).
import { describe, expect, it } from "vitest";
import { commandWords, shellSubject, simpleCommands } from "../src/office/office-shell-words.ts";

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
  ])("is empty when the first word is not plainly a name: %s", (command) => {
    expect(shellSubject(command)).toBe("");
  });
});

describe("shell words", () => {
  it("keeps quoted separators inside a word", () => {
    expect(simpleCommands(`echo "a && b"; ls`).map((c) => c.words.map((w) => w.text))).toEqual([["echo", "a && b"], ["ls"]]);
  });

  it("skips setup and wrappers to the real command", () => {
    expect(commandWords("cd x && sudo -u bob timeout 5 git pull").map((w) => w.text)).toEqual(["git", "pull"]);
    expect(commandWords("cd x").map((w) => w.text)).toEqual(["cd", "x"]);
  });
});
