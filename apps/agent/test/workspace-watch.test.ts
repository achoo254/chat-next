// Watching a workspace: file events gathered for 125 ms into the folders
// that changed, git's status looked at after a change at most every 3 s and
// every 60 s in any case, devices told about git only when it changed, and
// nothing watched once no device looks. Also the panel's requests over a
// device's sealed link.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason, GitFileState, WsFileKind } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { type FileWatch, WATCH_TIMINGS, type WorkspaceChange, WorkspaceWatcher } from "../src/workspace/watch.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { commitAll, repo, workspaces } from "./support/workspace-fixture.ts";

/** A file watch the test drives by hand. */
function manualWatch() {
  let fire: ((rel: string | null) => void) | undefined;
  let stopped = 0;
  const fileWatch: FileWatch = (_root, onEvent) => {
    fire = onEvent;
    return () => {
      stopped++;
      fire = undefined;
    };
  };
  return { fileWatch, fire: (rel: string | null) => fire?.(rel), stopped: () => stopped, live: () => fire !== undefined };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the watcher", () => {
  it("gathers a burst of events into one change of the folders, leaving build output out", async () => {
    vi.useFakeTimers();
    const w = manualWatch();
    const changes: WorkspaceChange[] = [];
    const watcher = new WorkspaceWatcher({ root: "/w", emit: (c) => changes.push(c), statusKey: async () => "same", fileWatch: w.fileWatch });
    watcher.start();
    for (let i = 0; i < 10; i++) {
      w.fire(`src/f${i}.ts`);
      await vi.advanceTimersByTimeAsync(10);
    }
    w.fire("top.txt");
    w.fire("node_modules/x/index.js");
    w.fire("dist/out.js");
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(WATCH_TIMINGS.debounceMs);
    expect(changes).toEqual([{ dirs: ["src", ""], overflow: false, git: false, polling: false }]);
    watcher.stop();
  });

  it("flushes within a second under a steady stream, and overflows past 200 folders", async () => {
    vi.useFakeTimers();
    const w = manualWatch();
    const changes: WorkspaceChange[] = [];
    const watcher = new WorkspaceWatcher({ root: "/w", emit: (c) => changes.push(c), statusKey: async () => "same", fileWatch: w.fileWatch });
    watcher.start();
    for (let t = 0; t < 1_100; t += 50) {
      w.fire("a/x");
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(changes.length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(200);
    changes.length = 0;
    for (let i = 0; i < 250; i++) w.fire(`d${i}/f`);
    w.fire(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(changes).toEqual([{ dirs: [], overflow: true, git: false, polling: false }]);
    watcher.stop();
  });

  it("looks at git at most every 3 s after changes, every 60 s anyway, and tells only a difference", async () => {
    vi.useFakeTimers();
    const w = manualWatch();
    const changes: WorkspaceChange[] = [];
    let key = "k0";
    const reads: number[] = [];
    const watcher = new WorkspaceWatcher({
      root: "/w",
      emit: (c) => changes.push(c),
      statusKey: async () => {
        reads.push(Date.now());
        return key;
      },
      fileWatch: w.fileWatch,
    });
    const start = Date.now();
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.length).toBe(1); // the status as it is when watching starts
    // Changes inside git's own folder only: a look at git, no folder named.
    key = "k1";
    w.fire(".git/index");
    await vi.advanceTimersByTimeAsync(200);
    w.fire(".git/index");
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.length).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reads.length).toBe(2);
    expect((reads[1] ?? 0) - start).toBeGreaterThanOrEqual(WATCH_TIMINGS.statusMinMs);
    expect(changes).toEqual([{ dirs: [], overflow: false, git: true, polling: false }]);
    // Same status again: nothing told.
    w.fire("a.txt");
    await vi.advanceTimersByTimeAsync(3_200);
    expect(reads.length).toBe(3);
    expect(changes.filter((c) => c.git).length).toBe(1);
    // No event at all: the 60 s look still sees a change made behind the watch's back.
    key = "k2";
    await vi.advanceTimersByTimeAsync(WATCH_TIMINGS.pollMs);
    expect(changes.filter((c) => c.git).length).toBe(2);
    watcher.stop();
    expect(w.stopped()).toBe(1);
    const before = reads.length;
    await vi.advanceTimersByTimeAsync(WATCH_TIMINGS.pollMs * 3);
    expect(reads.length).toBe(before);
  });

  it("runs only while someone listens", async () => {
    const dir = repo();
    const w = manualWatch();
    const { ws } = workspaces({ w: dir }, { fileWatch: w.fileWatch });
    const stopA = await ws.watch("w", () => undefined);
    const stopB = await ws.watch("w", () => undefined);
    expect(ws.watched).toBe(1);
    expect(w.live()).toBe(true);
    stopA();
    expect(w.live()).toBe(true);
    stopB();
    expect(ws.watched).toBe(0);
    expect(w.live()).toBe(false);
  });

  it("hears real file changes through the operating system", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "1\n");
    commitAll(dir);
    const { ws } = workspaces({ w: dir }, { watchTimings: { ...WATCH_TIMINGS, statusMinMs: 200 } });
    const changes: WorkspaceChange[] = [];
    const stop = await ws.watch("w", (c) => changes.push(c));
    try {
      // Let the watch settle (and the first status be read) before changing anything.
      await new Promise((r) => setTimeout(r, 500));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "new.txt"), "x\n");
      writeFileSync(join(dir, "a.txt"), "2\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !(changes.some((c) => c.git) && changes.some((c) => c.dirs.includes("sub") || c.overflow))) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(changes.some((c) => c.git)).toBe(true);
      expect(changes.some((c) => c.dirs.includes("sub") || c.overflow)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe("over a device's link", () => {
  it("lists, reads and reports git, refuses with reasons, and stops watching when the link closes", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commitAll(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    const w = manualWatch();
    const { ws, audit } = workspaces({ w: dir }, { fileWatch: w.fileWatch });
    const { core } = makeCore([fakeProvider()]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, workspaces: ws });
    const list = await device.request("1", { case: "wsDirList", value: { workspaceId: "w", path: "", showHidden: true } });
    expect(list.body.case).toBe("wsDirListResult");
    if (list.body.case === "wsDirListResult") {
      expect(list.body.value.entries.map((e) => [e.name, e.git])).toEqual([["a.txt", GitFileState.MODIFIED]]);
    }
    const read = await device.request("2", { case: "wsFileRead", value: { workspaceId: "w", path: "a.txt" } });
    expect(read.body).toMatchObject({ case: "wsFileReadResult", value: { kind: WsFileKind.TEXT, text: "changed\n" } });
    const secret = await device.request("3", { case: "wsFileRead", value: { workspaceId: "w", path: ".env" } });
    expect(secret.body).toMatchObject({ case: "error", value: { reason: ErrorReason.SECRET_FILE } });
    const escape = await device.request("4", { case: "wsFileRead", value: { workspaceId: "w", path: "../../etc/passwd" } });
    expect(escape.body).toMatchObject({ case: "error", value: { reason: ErrorReason.PATH_OUTSIDE_FOLDER } });
    const unknown = await device.request("5", { case: "wsGitStatus", value: { workspaceId: "nope" } });
    expect(unknown.body).toMatchObject({ case: "error", value: { reason: ErrorReason.PROJECT_NOT_FOUND } });
    const status = await device.request("6", { case: "wsGitStatus", value: { workspaceId: "w" } });
    expect(status.body).toMatchObject({ case: "wsGitStatusResult", value: { git: true, branch: "main" } });
    const discard = await device.request("7", { case: "wsGitDiscard", value: { workspaceId: "w", paths: ["a.txt"] } });
    expect(discard.body).toMatchObject({ case: "error", value: { reason: ErrorReason.DISCARD_NOT_CONFIRMED } });
    const watch = await device.request("8", { case: "wsWatch", value: { workspaceId: "w", on: true } });
    expect(watch.body.case).toBe("ack");
    expect(ws.watched).toBe(1);
    w.fire("src/x.ts");
    await vi.waitFor(() => expect(device.received.some((f) => f.body.case === "wsChanged")).toBe(true));
    const changed = device.received.find((f) => f.body.case === "wsChanged");
    expect(changed?.body).toMatchObject({ value: { workspaceId: "w", dirs: ["src"] } });
    device.close();
    expect(ws.watched).toBe(0);
  });
});
