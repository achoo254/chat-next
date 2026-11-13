// A commit message from agy in one go: `agy --sandbox` with every tool
// denied (files, commands, MCP, URLs) by settings given on the command line,
// in an empty folder, the prompt on stdin. It saves a conversation of agy's
// own but reads nothing of the machine. Hooks of other tools in agy's global
// hooks.json still run (agy has no way to switch them off for one run);
// tunelo's own hook stays out (no TUNELO_AGY in its environment).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextWriter, WriteRequest } from "../types.ts";
import { agyEnv } from "./agy.ts";

/** Settings that let the AI only answer: every tool is denied, in every mode. */
export const WRITER_SETTINGS = {
  toolPermission: "strict",
  permissions: { deny: ["read_file(*)", "write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "unsandboxed(*)"] },
};

export function writerArgs(): string[] {
  return ["--sandbox", "--input-format=stream-json", "--output-format=stream-json", `--settings=${JSON.stringify(WRITER_SETTINGS)}`];
}

/** The answer of a stream-json run: its `result` event's response; throws with agy's error when it failed. */
export function writerAnswer(stdout: string): string {
  for (const line of stdout.split("\n").reverse()) {
    let e: { event?: string; result?: { status?: string; response?: string; error?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.event !== "result" || !e.result) continue;
    if (e.result.status !== "SUCCESS") throw new Error(`agy failed: ${String(typeof e.result.error === "string" ? e.result.error : e.result.status)}`.slice(0, 300));
    return e.result.response ?? "";
  }
  throw new Error("agy gave no answer");
}

export function agyWriter(findBinary: () => Promise<string | null>): TextWriter {
  return {
    async write(req: WriteRequest): Promise<string> {
      const bin = await findBinary();
      if (!bin) throw new Error("agy is not installed");
      const dir = mkdtempSync(join(tmpdir(), "tunelo-agy-writer-"));
      try {
        return await new Promise<string>((resolve, reject) => {
          const child = spawn(bin, writerArgs(), { cwd: dir, env: agyEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          let out = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (c: string) => {
            if (out.length < 4 * 1024 * 1024) out += c;
          });
          child.stderr.on("data", () => undefined);
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("agy did not answer in time"));
          }, req.timeoutMs);
          child.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            try {
              resolve(writerAnswer(out));
            } catch (err) {
              reject(err as Error);
            }
          });
          child.stdin.on("error", () => undefined);
          child.stdin.end(`${JSON.stringify({ event: "user", message: { content: req.prompt } })}\n`);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
