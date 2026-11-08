// agent.log past its size: copied to .1 (older copies shift, at most 3) and
// emptied in place, so the supervisor's open append handle keeps working.
import { appendFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rotateLog } from "../src/log-rotate.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agent.log rotation", () => {
  test("leaves a small log alone; rotates a big one keeping three copies", () => {
    const log = join(dir, "agent.log");
    expect(rotateLog(log, 100)).toBe(false);
    writeFileSync(log, "small\n");
    expect(rotateLog(log, 100)).toBe(false);
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(log, `${String(n).repeat(200)}\n`);
      expect(rotateLog(log, 100)).toBe(true);
    }
    expect(statSync(log).size).toBe(0);
    expect(readFileSync(`${log}.1`, "utf8")[0]).toBe("4");
    expect(readFileSync(`${log}.2`, "utf8")[0]).toBe("3");
    expect(readFileSync(`${log}.3`, "utf8")[0]).toBe("2");
    expect(existsSync(`${log}.4`)).toBe(false);
    expect(statSync(`${log}.1`).mode & 0o777).toBe(0o600);
  });

  test("a writer holding the file in append mode keeps writing at the start after a rotation", () => {
    const log = join(dir, "agent.log");
    const fd = openSync(log, "a");
    writeSync(fd, "x".repeat(300));
    expect(rotateLog(log, 100)).toBe(true);
    writeSync(fd, "after\n");
    closeSync(fd);
    appendFileSync(log, "");
    expect(readFileSync(log, "utf8")).toBe("after\n");
  });
});
