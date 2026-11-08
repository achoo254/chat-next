// The first message a new AI receives when the user switches AI in the
// same chat window: what was asked, the last answer, tools that ran and the
// files that changed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Role, type Item } from "@achoo254/chat-proto/remote/remote";

const run = promisify(execFile);
const MAX = 8000;

export async function gitChanges(dir: string): Promise<{ stat: string; files: string[] }> {
  try {
    const stat = (await run("git", ["diff", "--stat", "HEAD"], { cwd: dir, timeout: 10_000 })).stdout.trim();
    const names = (await run("git", ["diff", "--name-only", "HEAD"], { cwd: dir, timeout: 10_000 })).stdout;
    return { stat: stat.slice(0, 2000), files: names.split(/\r?\n/).filter(Boolean).slice(0, 200) };
  } catch {
    return { stat: "", files: [] };
  }
}

export function buildHandoff(opts: { from: string; to: string; dir: string; items: Item[]; gitStat: string }): string {
  const users: string[] = [];
  let lastAnswer = "";
  const tools: string[] = [];
  for (const item of opts.items) {
    const b = item.body;
    if (b.case === "text" && b.value.role === Role.USER) users.push(b.value.text);
    if (b.case === "text" && b.value.role === Role.ASSISTANT) lastAnswer = b.value.text;
    if (b.case === "toolCall") tools.push(`${b.value.name}: ${b.value.summary}`);
  }
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const parts = [
    `You are taking over a coding session from ${opts.from} in ${opts.dir}. The user switched AI; you only see this summary.`,
    "",
    "User messages so far:",
    ...users.slice(-10).map((u) => `- ${clip(u, 600)}`),
    "",
    `Last answer from ${opts.from}:`,
    clip(lastAnswer, 2000) || "(none)",
  ];
  if (tools.length) parts.push("", "Tools that ran (latest last):", ...tools.slice(-25).map((t) => `- ${clip(t, 200)}`));
  if (opts.gitStat) parts.push("", "Uncommitted changes (git diff --stat):", opts.gitStat);
  parts.push("", "Continue from here. Ask the user before redoing work that may already be done.");
  return clip(parts.join("\n"), MAX);
}
