// `hda logs`: the end of agent.log, and with --follow every line written
// after it, until Ctrl+C. Works the same on Windows and macOS (no `tail`).
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const logFile = (configDir: string) => join(configDir, "agent.log");

/** The last `count` lines of `text`, without a trailing empty line. */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return count <= 0 ? [] : lines.slice(-count);
}

function readFrom(file: string, start: number, end: number): string {
  if (end <= start) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Prints the last lines; with `follow`, keeps printing new ones (a truncated log starts over). */
export async function tailLog(file: string, opts: { lines: number; follow: boolean; write: (s: string) => void; pollMs?: number; signal?: AbortSignal }): Promise<void> {
  if (!existsSync(file)) {
    if (!opts.follow) {
      opts.write(`No log yet at ${file}.\n`);
      return;
    }
  }
  let pos = existsSync(file) ? statSync(file).size : 0;
  // Only the end is read, so a big log prints at once.
  const head = Math.max(0, pos - 256 * 1024);
  const shown = lastLines(readFrom(file, head, pos), opts.lines);
  if (shown.length) opts.write(shown.join("\n") + "\n");
  if (!opts.follow) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < pos) pos = 0;
      if (size > pos) {
        opts.write(readFrom(file, pos, size));
        pos = size;
      }
    }, opts.pollMs ?? 500);
    opts.signal?.addEventListener("abort", () => {
      clearInterval(timer);
      resolve();
    });
  });
}
