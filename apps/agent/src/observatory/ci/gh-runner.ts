// Runs the GitHub CLI for the CI watcher (ci-watcher.ts): never through a
// shell, never asking anything (GH_PROMPT_DISABLED), plain output (NO_COLOR),
// no window on Windows, a bounded time and output. The watcher only reads
// (`--version`, `auth status`, `run list`); tests inject their own runner, so
// no test ever starts `gh`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs `gh` with `args`; resolves with its standard output, rejects when it fails, is missing or takes too long. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

/** Every `gh` call ends within this time. */
export const GH_TIMEOUT_MS = 15_000;
/** `gh run list --limit 20 --json …` is a few kilobytes; anything past this is not a run list. */
const GH_MAX_OUTPUT = 1024 * 1024;

/** The environment of a `gh` call: the agent's, with prompts, colours and the update check switched off. */
export function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" };
}

/** The runner of the installed `gh`. */
export const execGh: GhRunner = async (args) => {
  const { stdout } = await run("gh", [...args], { timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: GH_MAX_OUTPUT, env: ghEnv(), encoding: "utf8" });
  return stdout;
};
