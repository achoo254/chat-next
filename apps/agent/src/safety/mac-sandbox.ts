// The AI's processes tunelo starts on macOS (claude, agy) run inside macOS's
// sandbox (sandbox-exec) that keeps them out of the folders macOS protects and
// tunelo may not enter yet (MacFolders.aiFences). macOS refuses such a read at
// once ("Operation not permitted") instead of showing a prompt on the Mac's
// screen and holding the command until someone answers it, whatever the
// command is (`find /`, `ls ~`, a script). Everything else is allowed as before
// (allow default). Every process the AI starts inherits the sandbox.
//
// A sandbox cannot hold another one: a process inside it that calls
// sandbox-exec itself (Claude Code's own sandbox for Bash) fails. Such a
// session runs without tunelo's sandbox (claudeSandboxOn).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiFences } from "./mac-folders.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A path as a string literal of the sandbox profile language. */
function literal(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The profile: everything allowed, then the fences denied, then their openings allowed again (the last matching rule wins). */
export function sandboxProfile(fences: AiFences): string {
  const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${literal(p)})`).join(" ");
  const lines = ["(version 1)", "(allow default)", `(deny file-read* file-write* ${subpaths(fences.deny)})`];
  if (fences.allow.length > 0) lines.push(`(allow file-read* file-write* ${subpaths(fences.allow)})`);
  return `${lines.join("\n")}\n`;
}

/** Whether the AI's processes run in the sandbox: on macOS, with something to keep out, and sandbox-exec there. */
export function sandboxApplies(fences: AiFences, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  return platform === "darwin" && fences.deny.length > 0 && exists(SANDBOX_EXEC);
}

/** `file args…` run in the sandbox: sandbox-exec with the profile, then the program. */
export function sandboxedLaunch(fences: AiFences, file: string, args: string[]): { file: string; args: string[] } {
  if (!sandboxApplies(fences)) return { file, args };
  return { file: SANDBOX_EXEC, args: ["-p", sandboxProfile(fences), file, ...args] };
}

/**
 * A program the caller can only name by one path (the Agent SDK's
 * pathToClaudeCodeExecutable): a script in `dir` that runs `bin` in the
 * sandbox with every argument. Written once per profile and program; `bin`
 * itself when nothing is kept out.
 */
export function sandboxedProgram(fences: AiFences, bin: string, dir: string): string {
  if (!sandboxApplies(fences)) return bin;
  const profile = sandboxProfile(fences);
  const key = createHash("sha256").update(`${bin}\n${profile}`).digest("hex").slice(0, 16);
  const folder = join(dir, "sandbox");
  const profileFile = join(folder, `${key}.sb`);
  const script = join(folder, `${key}.sh`);
  const body = `#!/bin/sh\nexec ${SANDBOX_EXEC} -f '${profileFile.replaceAll("'", "'\\''")}' '${bin.replaceAll("'", "'\\''")}' "$@"\n`;
  if (!existsSync(script) || readFileSync(script, "utf8") !== body) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(profileFile, profile, { mode: 0o600 });
    writeFileSync(script, body, { mode: 0o700 });
  }
  return script;
}

/**
 * Claude Code's own sandbox (settings `sandbox.enabled`) runs Bash under
 * sandbox-exec, which fails inside tunelo's: true when the settings the
 * session loads turn it on.
 */
export function claudeSandboxOn(settingsFiles: string[]): boolean {
  return settingsFiles.some((file) => {
    try {
      const sandbox = (JSON.parse(readFileSync(file, "utf8")) as { sandbox?: { enabled?: unknown } }).sandbox;
      return sandbox?.enabled === true;
    } catch {
      return false;
    }
  });
}
