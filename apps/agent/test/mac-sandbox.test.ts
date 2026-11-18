// The AI's processes on macOS run in tunelo's sandbox: kept out of the
// protected folders not granted yet and of other apps' data, so a command
// that wanders into one fails at once instead of waiting on a macOS prompt.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MacFolders } from "../src/safety/mac-folders.ts";
import { SANDBOX_EXEC, claudeSandboxOn, sandboxApplies, sandboxProfile, sandboxedLaunch, sandboxedProgram } from "../src/safety/mac-sandbox.ts";
import { fakeProvider, type FakeLog } from "./fake-provider.ts";
import { makeCore, tempDir, until } from "./harness.ts";

// macOS sandbox rules are built on POSIX paths (/Users/...).
const posix = process.platform !== "win32";

const run = promisify(execFile);
const HOME = "/Users/an";

function folders(over: { fda?: boolean; saved?: Record<string, "granted" | "denied">; platform?: NodeJS.Platform } = {}) {
  return new MacFolders({
    platform: over.platform ?? "darwin",
    home: HOME,
    saved: () => over.saved ?? {},
    save: () => undefined,
    fullDiskAccess: () => over.fda ?? false,
    probe: async () => "granted",
    onChange: () => undefined,
    log: () => undefined,
    folders: () => [`${HOME}/Desktop`, `${HOME}/Documents`, `${HOME}/Music`],
  });
}

describe("what the AI's processes are kept out of", () => {
  it.skipIf(!posix)("is every protected folder not granted and other apps' data, with Docker's container open", () => {
    const fences = folders({ saved: { [`${HOME}/Documents`]: "granted" } }).aiFences();
    expect(fences.deny).toEqual([
      `${HOME}/Desktop`,
      `${HOME}/Music`,
      `${HOME}/Library/Containers`,
      `${HOME}/Library/Group Containers`,
      `${HOME}/Library/Application Support/AddressBook`,
      `${HOME}/Library/Calendars`,
    ]);
    expect(fences.allow).toEqual([`${HOME}/Library/Containers/com.docker.docker`, `${HOME}/Library/Group Containers/group.com.docker`]);
  });

  it("is nothing with Full Disk Access or off macOS", () => {
    expect(folders({ fda: true }).aiFences()).toEqual({ deny: [], allow: [] });
    expect(folders({ platform: "linux" }).aiFences()).toEqual({ deny: [], allow: [] });
  });
});

describe("the sandbox", () => {
  const fences = { deny: [`${HOME}/Desktop`, `${HOME}/My "Docs"`], allow: [`${HOME}/Desktop/open`] };

  it("allows everything, denies the fences, then opens their openings again", () => {
    expect(sandboxProfile(fences)).toBe(
      ['(version 1)', "(allow default)", `(deny file-read* file-write* (subpath "${HOME}/Desktop") (subpath "${HOME}/My \\"Docs\\""))`, `(allow file-read* file-write* (subpath "${HOME}/Desktop/open"))`, ""].join("\n"),
    );
  });

  it("applies only on macOS with something to keep out", () => {
    expect(sandboxApplies(fences, "darwin", () => true)).toBe(true);
    expect(sandboxApplies({ deny: [], allow: [] }, "darwin", () => true)).toBe(false);
    expect(sandboxApplies(fences, "linux", () => true)).toBe(false);
    expect(sandboxApplies(fences, "darwin", () => false)).toBe(false);
    expect(sandboxedLaunch({ deny: [], allow: [] }, "/bin/agy", ["acp"])).toEqual({ file: "/bin/agy", args: ["acp"] });
  });

  it("knows when Claude Code's own sandbox is on, which cannot run inside tunelo's", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "on.json"), JSON.stringify({ sandbox: { enabled: true } }));
    writeFileSync(join(dir, "off.json"), JSON.stringify({ model: "opus" }));
    expect(claudeSandboxOn([join(dir, "off.json"), join(dir, "missing.json")])).toBe(false);
    expect(claudeSandboxOn([join(dir, "off.json"), join(dir, "on.json")])).toBe(true);
  });

  it.runIf(process.platform === "darwin" && existsSync(SANDBOX_EXEC))("on this Mac: a command reading a fenced folder fails at once and the rest still works", async () => {
    const root = tempDir();
    const kept = join(root, "kept");
    const open = join(root, "open");
    mkdirSync(join(kept, "inside"), { recursive: true });
    mkdirSync(open);
    const live = { deny: [kept], allow: [join(kept, "inside")] };
    const script = sandboxedProgram(live, "/bin/sh", join(root, "cfg"));
    expect(script).not.toBe("/bin/sh");
    expect(readFileSync(script, "utf8")).toContain(SANDBOX_EXEC);
    const started = Date.now();
    const { stdout } = await run(script, ["-c", `ls "${kept}" >/dev/null 2>&1 && echo kept-open || echo kept-denied; ls "${join(kept, "inside")}" >/dev/null && echo inside-open; ls "${open}" >/dev/null && echo open-open`]);
    expect(stdout.trim().split("\n")).toEqual(["kept-denied", "inside-open", "open-open"]);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The same profile and program reuse the same script.
    expect(sandboxedProgram(live, "/bin/sh", join(root, "cfg"))).toBe(script);
  });
});

describe("a folder granted while sessions are open", () => {
  it("restarts an idle session now and a busy one once its turn ends; the conversation goes on", async () => {
    const log: FakeLog = { starts: [], sent: [], closed: 0 };
    const { core, work } = makeCore([fakeProvider("fake", log)]);
    const consent = { sensitive: false, projectSettings: false };
    const idle = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
    await until(core, idle.id, (items) => items.some((i) => i.body.case === "text" && i.body.value.text === "echo: hi"));
    const busy = await core.create({ provider: "fake", model: "", dir: work, text: "slow", consent, device: "test" });
    await vi.waitFor(() => expect(core.snapshot(busy.id).some((i) => i.body.case === "text")).toBe(true));
    core.macAccessGranted();
    await vi.waitFor(() => expect(log.closed).toBe(1));
    await core.interrupt(busy.id);
    await vi.waitFor(() => expect(log.closed).toBe(2));
    await core.send(idle.id, "again", "m2");
    await until(core, idle.id, (items) => items.some((i) => i.body.case === "text" && i.body.value.text === "echo: again"));
    await core.stop();
  });
});
