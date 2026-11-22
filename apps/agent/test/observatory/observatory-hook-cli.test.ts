// `tunelo observatory hook <event>` through the real CLI, as an installed
// hook runs it (exec form: the binary and its arguments, no shell): the
// payload on stdin becomes one filtered line in the spool of the data folder,
// and the command exits 0 at once, also for an event it does not keep or a
// payload that is not JSON. It runs without the sign-in import of every other
// command (cli.ts preAction): a legacy sign-in file is left where it is.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliBundle, machineEnv } from "../support/mcp-harness.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

let cli = "";
beforeAll(async () => {
  cli = await buildCliBundle("observatory-hook");
});

function hook(home: string, event: string, stdin: string): Promise<{ code: number | null; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "observatory", "hook", event], { env: machineEnv(home), stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, ms: performance.now() - started }));
    child.stdin.end(stdin);
  });
}

const spoolLines = (home: string): string[] => {
  const dir = join(home, "tunelo", "observatory", "spool");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith("events-"))
    .flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean));
};

describe("tunelo observatory hook", () => {
  it("writes one filtered line to the spool and exits 0", async () => {
    const home = obsTempDir("hook-cli");
    const work = join(home, "work", "app");
    mkdirSync(work, { recursive: true });
    // The plain session file of tunelo 2.0: every other command moves (and deletes) it before running.
    const legacy = join(home, "tunelo", "tunelo-session.json");
    mkdirSync(join(home, "tunelo"), { recursive: true });
    writeFileSync(legacy, "{}");
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "s-1", prompt_id: "p-1", cwd: work, prompt: "fix the build", transcript_path: join(home, "t.jsonl") };
    const out = await hook(home, "UserPromptSubmit", JSON.stringify(payload));
    expect(out.code).toBe(0);
    const lines = spoolLines(home);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { event: string; f: Record<string, unknown>; c?: Record<string, string> };
    expect(record.event).toBe("UserPromptSubmit");
    expect(record.f.session_id).toBe("s-1");
    expect(String(record.f.cwd).replaceAll("\\", "/")).toBe("~/work/app");
    expect(record.c?.prompt).toBe("fix the build");
    expect(lines[0]).not.toContain("transcript");
    expect(existsSync(legacy)).toBe(true);
  });

  it("exits 0 for an event it does not keep and for a payload that is not JSON, writing nothing", async () => {
    const home = obsTempDir("hook-cli-skip");
    expect((await hook(home, "MessageDisplay", JSON.stringify({ session_id: "s", delta: "x" }))).code).toBe(0);
    expect((await hook(home, "Stop", "not json")).code).toBe(0);
    expect(spoolLines(home)).toEqual([]);
  });
});
