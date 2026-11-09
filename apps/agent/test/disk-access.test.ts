// Full Disk Access on macOS: what the probe concludes, and which file errors
// are macOS refusing for the lack of it.
import { describe, expect, test } from "vitest";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { errorBody } from "../src/link/connection.ts";
import { type DiskAccessProbe, diskAccess, diskAccessSteps, isDiskAccessDenial } from "../src/safety/disk-access.ts";

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

test("the steps name the binary to add and how to restart", () => {
  const text = diskAccessSteps("/Users/me/.local/bin/tunelo").join("\n");
  expect(text).toContain("/Users/me/.local/bin/tunelo");
  expect(text).toContain("Full Disk Access");
  expect(text).toContain("tunelo stop");
});

test("a file error a device gets stays a known reason on this system", () => {
  // EACCES is a file permission, never Full Disk Access.
  expect(errorBody(fsError("EACCES")).reason).toBe(ErrorReason.ACCESS_DENIED);
  const expected = isDiskAccessDenial(fsError("EPERM")) ? ErrorReason.FULL_DISK_ACCESS_NEEDED : ErrorReason.ACCESS_DENIED;
  expect(errorBody(fsError("EPERM")).reason).toBe(expected);
});
