// The machine's Claude settings followed while the service runs: a burst of
// changes to settings.json or keybindings.json is answered once, other files
// in the folder are ignored, nothing is answered after stop, and a folder
// that cannot be watched is logged instead of failing the service.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchMachineSettings } from "../src/providers/claude/accounts/settings-watch.ts";
import { tempDir } from "./harness.ts";

const DELAY_MS = 150; // above how long macOS gathers file events, so one burst stays one
const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function watched() {
  const claudeHome = join(tempDir("settings-watch-"), "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  let calls = 0;
  const logs: string[] = [];
  const stop = watchMachineSettings(claudeHome, () => (calls += 1), (l) => logs.push(l), DELAY_MS);
  stops.push(stop);
  return { claudeHome, stop, logs, calls: () => calls };
}

describe("following the machine's settings", () => {
  it("answers a burst of settings changes once, and key bindings too", async () => {
    const w = watched();
    await settle(100); // some systems start reporting a moment after the watch opens
    for (let i = 0; i < 5; i += 1) writeFileSync(join(w.claudeHome, "settings.json"), JSON.stringify({ i }));
    await settle();
    expect(w.calls()).toBe(1);
    writeFileSync(join(w.claudeHome, "keybindings.json"), "[]");
    await settle();
    expect(w.calls()).toBe(2);
  });

  it("ignores the other files claude keeps writing in its folder", async () => {
    const w = watched();
    await settle(100);
    writeFileSync(join(w.claudeHome, "history.jsonl"), '{"display":"x"}\n');
    writeFileSync(join(w.claudeHome, "settings.json.tmp.123"), "{}");
    await settle();
    expect(w.calls()).toBe(0);
  });

  it("answers nothing after stop, even a change already waiting", async () => {
    const w = watched();
    await settle(100);
    writeFileSync(join(w.claudeHome, "settings.json"), "{}");
    w.stop();
    await settle();
    writeFileSync(join(w.claudeHome, "settings.json"), '{"a":1}');
    await settle();
    expect(w.calls()).toBe(0);
  });

  it("logs a folder it cannot watch and goes on", () => {
    const logs: string[] = [];
    const stop = watchMachineSettings(join(tempDir("settings-watch-"), "missing"), () => undefined, (l) => logs.push(l));
    stops.push(stop);
    expect(logs.join("\n")).toMatch(/cannot follow the machine's settings/);
    expect(() => stop()).not.toThrow();
  });
});
