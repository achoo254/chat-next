// One answer from `claude -p` for a prompt on stdin (a commit message): no
// tool, no setting source (so no project settings, hooks or CLAUDE.md), no MCP
// server, no slash command, no saved session. It runs as the account picked on
// the machine, from the home folder, never in the workspace.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { claudeEnv } from "./accounts/account.ts";
import type { TextWriter, WriteRequest } from "../types.ts";

/** Claude's pick for short writing: quick, and light on the plan's usage. */
export const WRITER_MODEL = "haiku";
/** Longest answer kept; a commit message is far shorter. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export function writerArgs(model: string): string[] {
  return ["-p", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--model", model];
}

/** `models`: Claude's own model ids; any other asked model falls back to WRITER_MODEL. */
export function claudeWriter(findBinary: () => Promise<string | null>, models: readonly string[]): TextWriter {
  return {
    async write(req: WriteRequest): Promise<string> {
      const bin = await findBinary();
      if (!bin) throw new Error("claude is not installed");
      const model = req.model !== undefined && models.includes(req.model) ? req.model : WRITER_MODEL;
      return runOnce(bin, writerArgs(model), req);
    },
  };
}

function runOnce(bin: string, args: string[], req: WriteRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: homedir(), env: claudeEnv(req.account?.dir), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("claude took too long"));
    }, req.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (out.length < MAX_OUTPUT_CHARS) out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err = (err + chunk).slice(-4000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim() !== "") return resolve(out.trim());
      const last = err.trim().split("\n").pop() ?? "";
      reject(new Error(last !== "" ? last : `claude exited with ${code ?? "a signal"}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(req.prompt);
  });
}
