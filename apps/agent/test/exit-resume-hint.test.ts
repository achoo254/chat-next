// The line Claude prints when it exits names the session to open again.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resumeHintIn, resumeHintOfSession } from "../src/terminal/exit-resume-hint.ts";
import { termHostDir } from "../src/terminal/host-link.ts";
import { tempDir } from "./harness.ts";

const ID = "d1bc4307-be61-4ef9-aa59-12b14b35abcb";

describe("the resume line Claude prints on exit", () => {
  test("is found through colours and cursor moves, in lowercase", () => {
    const out = `\x1b[2mResume this session with:\x1b[0m\r\n\x1b[1mclaude --resume\x1b[0m \x1b[36m${ID.toUpperCase()}\x1b[0m\r\n`;
    expect(resumeHintIn(out)).toBe(ID);
  });

  test("the latest line wins when the CLI exited and started again in one terminal", () => {
    const later = "9f3c2a10-1111-4222-8333-444455556666";
    expect(resumeHintIn(`claude --resume ${ID}\r\n$ claude\r\nclaude --resume ${later}\r\n`)).toBe(later);
  });

  test("no line, or an id that is not one, gives nothing", () => {
    expect(resumeHintIn("Ctx 45% | bypass permissions on")).toBeUndefined();
    expect(resumeHintIn("claude --resume not-a-session")).toBeUndefined();
  });

  test("is read from the end of the session's output log; a missing log gives nothing", () => {
    const config = tempDir("config-");
    expect(resumeHintOfSession(config, 7)).toBeUndefined();
    const dir = join(termHostDir(config), "output");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session-7.log"), `${"x".repeat(40_000)}\r\nResume this session with:\r\nclaude --resume ${ID}\r\n`);
    expect(resumeHintOfSession(config, 7)).toBe(ID);
  });
});
