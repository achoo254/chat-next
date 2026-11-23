// What the filter derives for the Live Map: present whatever the project's
// content setting, and never the command line or the full path.
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import { type HookFilterContext, filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import { TARGET_KEY_SALT_FILE, deleteTargetKeySalt, ensureTargetKeySalt, readTargetKeySalt, targetKeyOf, targetKeyPath } from "../../src/observatory/privacy/target-key-salt.ts";
import { tempDir } from "../harness.ts";
import { FAKE_CWD, FAKE_HOME, isFakeSensitive } from "./observatory-payloads.ts";

const SALT = Buffer.alloc(32, 7);
const posix = process.platform !== "win32";
const contentOff: HookFilterContext = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: false, stage: "hook", targetKeySalt: SALT };

function pre(toolName: string, toolInput: unknown, ctx: HookFilterContext = contentOff) {
  const r = filterHookEvent("PreToolUse", { session_id: "s", cwd: FAKE_CWD, tool_name: toolName, tool_use_id: "t", tool_input: toolInput }, ctx, 1);
  if (!r) throw new Error("dropped");
  return r;
}

describe("the station in a filtered record", () => {
  it("is kept with content off, and the record holds neither the command line nor the full path", () => {
    const command = "cd ~/work/example-app && pnpm run test -- --grep secret-word";
    const shell = pre("Bash", { command });
    expect(shell.f).toMatchObject({ station: "TESTING", station_flags: 0, target: "pnpm" });
    expect(shell.c).toBeUndefined();
    expect(JSON.stringify(shell)).not.toContain("secret-word");

    const file = join(FAKE_CWD, ".claude", "rules", "private-topic.md");
    const edit = pre("Edit", { file_path: file, old_string: "a", new_string: "b" });
    expect(edit.f).toMatchObject({ station: "MEMORY", station_flags: StationFlag.write | StationFlag.memory });
    const text = JSON.stringify(edit);
    expect(text).not.toContain(FAKE_HOME);
    expect(text).not.toContain("example-app/.claude");
    expect(text).not.toContain("example-app\\\\.claude");
  });

  it("tells a push and a deploy apart, which the program name alone cannot", () => {
    expect(pre("Bash", { command: "git push origin main" }).f).toMatchObject({ station: "GIT", station_flags: StationFlag.push, target: "git" });
    expect(pre("Bash", { command: "git commit -m 'x'" }).f).toMatchObject({ station: "GIT", station_flags: StationFlag.commit, target: "git" });
    expect(pre("Bash", { command: "./infra/deploy.sh prod" }).f).toMatchObject({ station: "GIT", station_flags: StationFlag.deploy });
  });

  it("keeps a Read's page and a TodoWrite's counts, not the items' text", () => {
    expect(pre("Read", { file_path: join(FAKE_CWD, "a.ts"), offset: 200, limit: 100 }).f).toMatchObject({ read_offset: 200, read_limit: 100 });
    const todo = pre("TodoWrite", {
      todos: [
        { content: "write the secret plan", status: "pending" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
        { content: "d", status: "completed" },
      ],
    });
    expect(todo.f).toMatchObject({ station: "ORCHESTRATOR", todo_pending: 1, todo_in_progress: 1, todo_done: 2 });
    expect(JSON.stringify(todo)).not.toContain("secret plan");
  });
});

describe("target_key", () => {
  it("tells two files of the same folder/name apart, and gives one file the same key in the hook and in the agent", () => {
    const a = pre("Read", { file_path: join(FAKE_CWD, "apps", "web", "src", "index.ts") }).f;
    const b = pre("Read", { file_path: join(FAKE_CWD, "apps", "agent", "src", "index.ts") }).f;
    expect(a.target).toBe(b.target);
    expect(a.target_key).toMatch(/^[0-9a-f]{32}$/);
    expect(a.target_key).not.toBe(b.target_key);

    const inAgent = pre("Edit", { file_path: join(FAKE_CWD, "apps", "web", "src", "index.ts") }, { ...contentOff, stage: "final", contentAllowed: true }).f;
    expect(inAgent.target_key).toBe(a.target_key);
    // A relative path names the same file under the session's folder.
    expect(pre("Read", { file_path: join("apps", "web", "src", "index.ts") }).f.target_key).toBe(a.target_key);
  });

  it("is not kept without a salt, nor for a tool that names no file", () => {
    expect(pre("Read", { file_path: join(FAKE_CWD, "a.ts") }, { ...contentOff, targetKeySalt: undefined }).f.target_key).toBeUndefined();
    expect(pre("Bash", { command: "cat a.ts" }).f.target_key).toBeUndefined();
  });

  it("depends on the salt", () => {
    const path = join(FAKE_CWD, "a.ts");
    expect(targetKeyOf(SALT, path, FAKE_HOME, undefined)).not.toBe(targetKeyOf(Buffer.alloc(32, 8), path, FAKE_HOME, undefined));
  });

  it("is made of the path with ~, forward slashes, and lower case on Windows", () => {
    expect(targetKeyPath("C:\\Users\\Dev\\Work\\A.ts", "C:\\Users\\Dev", undefined, "win32")).toBe("~/work/a.ts");
    expect(targetKeyPath("/home/dev/Work/A.ts", "/home/dev", undefined, "linux")).toBe("~/Work/A.ts");
    expect(targetKeyPath("A.ts", "/home/dev", undefined, "linux")).toBeUndefined();
  });
});

describe("the target key salt file", () => {
  it("is made once, 32 bytes, and read back the same", async () => {
    const dir = join(tempDir("observatory-salt-"), "observatory");
    expect(await readTargetKeySalt(dir)).toBeUndefined();
    const salt = await ensureTargetKeySalt(dir);
    expect(salt).toHaveLength(32);
    expect(await ensureTargetKeySalt(dir)).toEqual(salt);
    expect(await readTargetKeySalt(dir)).toEqual(salt);
    if (posix) expect(statSync(join(dir, TARGET_KEY_SALT_FILE)).mode & 0o777).toBe(0o600);
    await deleteTargetKeySalt(dir);
    expect(await readTargetKeySalt(dir)).toBeUndefined();
  });

  it("is replaced when it is not 32 bytes", async () => {
    const dir = tempDir("observatory-salt-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, TARGET_KEY_SALT_FILE), "short");
    if (posix) chmodSync(join(dir, TARGET_KEY_SALT_FILE), 0o644);
    expect(await readTargetKeySalt(dir)).toBeUndefined();
    expect(await ensureTargetKeySalt(dir)).toHaveLength(32);
  });
});
