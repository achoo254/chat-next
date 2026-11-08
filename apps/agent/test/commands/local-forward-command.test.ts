// `tunelo config local-forward`: ports are checked before anything changes,
// and the state reads plainly whether the service runs or not.
import { describe, expect, test } from "vitest";
import { describeLocalForward, parsePorts } from "../../src/commands/config.ts";

describe("tunelo config local-forward", () => {
  test("ports: separate words or commas, 1-65535 only", () => {
    expect(parsePorts(["8080", "3001,4000"])).toEqual([8080, 3001, 4000]);
    expect(() => parsePorts([])).toThrow(/one or more ports/);
    expect(() => parsePorts(["70000"])).toThrow(/not a port/);
    expect(() => parsePorts(["0"])).toThrow(/not a port/);
    expect(() => parsePorts(["80a"])).toThrow(/not a port/);
  });

  test("the state says on or off, why nothing is forwarded, and the ports added here", () => {
    const off = describeLocalForward({ enabled: false, available: true, blockedPorts: [] }, true).join("\n");
    expect(off).toContain("Forwarding to localhost: off");
    expect(off).toContain("tunelo config local-forward on");
    const waiting = describeLocalForward({ enabled: true, available: false, blockedPorts: [8080] }, true).join("\n");
    expect(waiting).toContain("does not carry these requests yet");
    expect(waiting).toContain("Also never forwarded on this machine: 8080.");
    expect(describeLocalForward({ enabled: true, available: false, blockedPorts: [] }, false).join("\n")).toContain("not running");
  });
});
