// When Claude exits it prints "Resume this session with: claude --resume <id>":
// the session the conversation on screen ended in (after /clear or /resume
// this is not the one the terminal started with). The register of running
// claudes is gone by then, so this line is the only exact record of it.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { termHostDir } from "./host-link.ts";

/** The end of the output that can hold the hint: it is printed last, under the status line. */
const TAIL_BYTES = 16 * 1024;
const HINT = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
// eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters by definition
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** The session id the latest "claude --resume <id>" line of `output` names (lowercase); undefined when there is none. */
export function resumeHintIn(output: string): string | undefined {
  const text = output.replace(ESCAPES, "");
  let last: string | undefined;
  for (const m of text.matchAll(HINT)) last = m[1]?.toLowerCase();
  return last;
}

/** The hint at the end of terminal `session`'s output log, as tunelo-term-host keeps it. Never fails. */
export function resumeHintOfSession(configDir: string, session: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(termHostDir(configDir), "output", `session-${session}.log`), "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return resumeHintIn(buf.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
