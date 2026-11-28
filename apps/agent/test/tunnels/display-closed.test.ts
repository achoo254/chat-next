// A tunnel closed on purpose (from Chat, by `tunelo`, or as tunelo stops) is
// said plainly in the terminal, never as an error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Display } from "../../src/tunnels/display.ts";

afterEach(() => vi.restoreAllMocks());

describe("Display.showClosed", () => {
  it("says the tunnel closed and why, without an Error prefix", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    new Display().showClosed("closed from Chat");
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("Tunnel closed from Chat.");
    expect(line).not.toContain("Error");
  });
});
