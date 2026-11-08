import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastLines, tailLog } from "../src/log-tail.ts";
import { tempDir } from "./harness.ts";

describe("tunelo logs", () => {
  it("keeps the last lines, Windows line ends included", () => {
    expect(lastLines("a\r\nb\r\nc\r\n", 2)).toEqual(["b", "c"]);
    expect(lastLines("a\nb", 5)).toEqual(["a", "b"]);
    expect(lastLines("a\n", 0)).toEqual([]);
  });

  it("prints the end, then follows new lines until stopped", async () => {
    const file = join(tempDir(), "agent.log");
    writeFileSync(file, "one\ntwo\nthree\n");
    let out = "";
    const stop = new AbortController();
    const done = tailLog(file, { lines: 2, follow: true, write: (s) => (out += s), pollMs: 10, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 30));
    appendFileSync(file, "four\n");
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await done;
    expect(out).toBe("two\nthree\nfour\n");
  });

  it("says so when there is no log yet", async () => {
    let out = "";
    await tailLog(join(tempDir(), "agent.log"), { lines: 5, follow: false, write: (s) => (out += s) });
    expect(out).toContain("No log yet");
  });
});
