// The model a session that picks none runs with, as the machine's Claude
// settings name it: only the "model" setting, nothing else of the file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsModel } from "../src/providers/claude/index.ts";
import { tempDir } from "./harness.ts";

function home(settings: string | null): string {
  const dir = tempDir("claude-home-");
  mkdirSync(dir, { recursive: true });
  if (settings !== null) writeFileSync(join(dir, "settings.json"), settings);
  return dir;
}

describe("the default model of the machine's Claude", () => {
  it("is the model its settings name", () => {
    expect(settingsModel(home(JSON.stringify({ model: "opus", theme: "dark" })))).toBe("opus");
    expect(settingsModel(home(JSON.stringify({ model: "claude-opus-5-5[1m]" })))).toBe("claude-opus-5-5[1m]");
  });

  it("is unknown without settings, without a model in them, or with one that is not a plain name", () => {
    expect(settingsModel(home(null))).toBeUndefined();
    expect(settingsModel(home("{ not json"))).toBeUndefined();
    expect(settingsModel(home(JSON.stringify({ theme: "dark" })))).toBeUndefined();
    expect(settingsModel(home(JSON.stringify({ model: "opus; rm -rf /" })))).toBeUndefined();
    expect(settingsModel(home(JSON.stringify({ model: 3 })))).toBeUndefined();
  });
});
