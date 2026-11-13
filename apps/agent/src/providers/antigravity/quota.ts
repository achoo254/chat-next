// agy's plan usage: `agy -p /usage --output-format json` answers without a
// model turn. Its groups (Gemini, then Claude and GPT models) each have a
// weekly and a 5-hour bucket with the fraction left; tunelo shows the
// tighter group of each window.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { RateWindow } from "../types.ts";
import { agyEnv } from "./agy.ts";

const run = promisify(execFile);

type Bucket = { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };

/** The windows of a /usage answer, as percent used; undefined when it holds none. */
export function parseUsage(json: string): { fiveHour?: RateWindow; sevenDay?: RateWindow } | undefined {
  let groups: { buckets?: Bucket[] }[];
  try {
    const data = (JSON.parse(json) as { command?: { data?: { groups?: unknown } } }).command?.data?.groups;
    if (!Array.isArray(data)) return undefined;
    groups = data as { buckets?: Bucket[] }[];
  } catch {
    return undefined;
  }
  const out: { fiveHour?: RateWindow; sevenDay?: RateWindow } = {};
  for (const b of groups.flatMap((g) => (Array.isArray(g.buckets) ? g.buckets : []))) {
    if (typeof b.remaining_fraction !== "number") continue;
    const key = b.window === "5h" ? "fiveHour" : b.window === "weekly" ? "sevenDay" : undefined;
    if (!key) continue;
    const resetsAt = typeof b.reset_time === "string" ? Date.parse(b.reset_time) || 0 : 0;
    const utilization = Math.round(Math.min(1, Math.max(0, 1 - b.remaining_fraction)) * 100);
    const prev = out[key];
    if (!prev || utilization > prev.utilization) out[key] = { utilization, resetsAt };
  }
  return out.fiveHour || out.sevenDay ? out : undefined;
}

export async function probeAgyUsage(bin: string): Promise<{ fiveHour?: RateWindow; sevenDay?: RateWindow } | null> {
  try {
    const { stdout } = await run(bin, ["--output-format", "json", "-p", "/usage"], { cwd: homedir(), env: agyEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 });
    return parseUsage(stdout) ?? null;
  } catch {
    return null;
  }
}
