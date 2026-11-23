// Whole lines of a file from a position on, but no line starting past a
// given end: the agent reads the AIs' growing records a bounded piece at a
// time (a byte budget per read), and goes on from where it stopped the next
// time. A line still being written (no newline yet) is left for later; a
// line longer than `cap` is skipped whole.
import { open } from "node:fs/promises";

const CHUNK = 256 * 1024;

/**
 * Calls `onLine` with each whole line that starts at or after `from` and
 * before `end`. `next`: the byte after the last line passed (or skipped as
 * too long), where the next read starts; `bytesRead`: what was read from
 * the file, a line not finished yet included (it counts against a budget).
 */
export async function readLinesUntil(
  path: string,
  from: number,
  end: number,
  cap: number,
  onLine: (line: Buffer) => void,
): Promise<{ next: number; bytesRead: number }> {
  if (end <= from) return { next: from, bytesRead: 0 };
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    /** Where the line being read starts. */
    let lineStart = from;
    let parts: Buffer[] = [];
    let length = 0;
    let skipping = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) return { next: lineStart, bytesRead: pos - from };
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        const stop = nl < 0 || nl >= bytesRead ? bytesRead : nl;
        if (!skipping) {
          length += stop - start;
          if (length > cap) {
            skipping = true;
            parts = [];
          } else if (stop === bytesRead && stop > start) parts.push(Buffer.from(buf.subarray(start, stop)));
        }
        if (stop === bytesRead) break;
        if (!skipping) onLine(parts.length === 0 ? buf.subarray(start, stop) : Buffer.concat([...parts, buf.subarray(start, stop)]));
        parts = [];
        length = 0;
        skipping = false;
        lineStart = pos + nl + 1;
        start = nl + 1;
        if (lineStart >= end) return { next: lineStart, bytesRead: pos + bytesRead - from };
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}
