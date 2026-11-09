// Full Disk Access on macOS: what the probe concludes, and which file errors
// are macOS refusing for the lack of it.
import { afterEach, describe, expect, test, vi } from "vitest";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { errorBody } from "../src/link/connection.ts";
import { type DiskAccess, type DiskAccessProbe, DiskAccessWatch, diskAccess, diskAccessSteps, isDiskAccessDenial } from "../src/safety/disk-access.ts";

const fsError = (code: string) => Object.assign(new Error(`${code}: operation failed`), { code });
const refusing = (code: string): DiskAccessProbe => ({
  platform: "darwin",
  listProtected: () => {
    throw fsError(code);
  },
});
const granted: DiskAccessProbe = { platform: "darwin", listProtected: () => undefined };

describe("diskAccess", () => {
  test("macOS refusing the protected folder means Full Disk Access is needed", () => {
    expect(diskAccess(refusing("EPERM"))).toBe("needed");
    expect(diskAccess(refusing("EACCES"))).toBe("needed");
  });

  test("a readable protected folder means it is granted", () => {
    expect(diskAccess(granted)).toBe("granted");
  });

  test("off macOS, or when the folder is not there, it does not apply", () => {
    expect(diskAccess({ platform: "linux", listProtected: () => undefined })).toBe("not-applicable");
    expect(diskAccess({ platform: "win32", listProtected: () => undefined })).toBe("not-applicable");
    expect(diskAccess(refusing("ENOENT"))).toBe("not-applicable");
  });
});

describe("isDiskAccessDenial", () => {
  test("only EPERM on a Mac without Full Disk Access", () => {
    expect(isDiskAccessDenial(fsError("EPERM"), refusing("EPERM"))).toBe(true);
    expect(isDiskAccessDenial(fsError("EACCES"), refusing("EPERM"))).toBe(false);
    expect(isDiskAccessDenial(fsError("EPERM"), granted)).toBe(false);
    expect(isDiskAccessDenial(fsError("EPERM"), { platform: "linux", listProtected: () => undefined })).toBe(false);
    expect(isDiskAccessDenial("EPERM", refusing("EPERM"))).toBe(false);
  });
});

test("the steps say to drag tunelo in, switch it on, and name the binary", () => {
  for (const opened of [true, false]) {
    const text = diskAccessSteps("/Users/me/.local/bin/tunelo", opened).join("\n");
    expect(text).toContain("/Users/me/.local/bin/tunelo");
    expect(text).toContain("Full Disk Access");
    expect(text).toMatch(/drag/i);
    expect(text).toMatch(/nothing to restart/);
  }
});

test("only steps shown right after opening them say System Settings and Finder are open", () => {
  expect(diskAccessSteps("/b/tunelo", true).join("\n")).toMatch(/Finder window showing tunelo are open/);
  // The service starting by itself (log) and `tunelo status` open nothing.
  const quiet = diskAccessSteps("/b/tunelo", false).join("\n");
  expect(quiet).not.toMatch(/are open/);
  expect(quiet).toMatch(/Open System Settings > Privacy & Security > Full Disk Access/);
});

test("a file error a device gets stays a known reason on this system", () => {
  // EACCES is a file permission, never Full Disk Access.
  expect(errorBody(fsError("EACCES")).reason).toBe(ErrorReason.ACCESS_DENIED);
  const expected = isDiskAccessDenial(fsError("EPERM")) ? ErrorReason.FULL_DISK_ACCESS_NEEDED : ErrorReason.ACCESS_DENIED;
  expect(errorBody(fsError("EPERM")).reason).toBe(expected);
});

describe("DiskAccessWatch", () => {
  afterEach(() => vi.useRealTimers());

  function watch(states: DiskAccess[], fresh: DiskAccess = "needed") {
    let i = 0;
    const calls = { granted: 0, restart: 0, fresh: 0 };
    const w = new DiskAccessWatch({
      check: () => states[Math.min(i++, states.length - 1)] ?? "needed",
      checkFresh: async () => {
        calls.fresh += 1;
        return fresh;
      },
      onGranted: () => (calls.granted += 1),
      onGrantedAfterRestart: () => (calls.restart += 1),
      intervalMs: 1_000,
      freshEvery: 3,
    });
    return { w, calls };
  }

  test("does not watch when the access is there or does not apply", () => {
    expect(watch(["granted"]).w.start()).toBe(false);
    expect(watch(["not-applicable"]).w.start()).toBe(false);
  });

  test("tells once, and stops, as soon as this process has it", async () => {
    vi.useFakeTimers();
    const { w, calls } = watch(["needed", "needed", "granted"]);
    expect(w.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.granted).toBe(1);
    expect(calls.restart).toBe(0);
    expect(w.watching).toBe(false);
  });

  test("a new process that has it while this one does not: restart", async () => {
    vi.useFakeTimers();
    const { w, calls } = watch(["needed"], "granted");
    w.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.fresh).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.fresh).toBe(1);
    expect(calls.restart).toBe(1);
    expect(calls.granted).toBe(0);
    expect(w.watching).toBe(false);
  });

  test("keeps watching while nobody granted it", async () => {
    vi.useFakeTimers();
    const { w, calls } = watch(["needed"]);
    w.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.fresh).toBe(3);
    expect(calls.granted + calls.restart).toBe(0);
    expect(w.watching).toBe(true);
    w.stop();
  });
});
