// advisor_git: git for the AI of an Advisor thread, which runs no command of
// its own (advisor-guard.ts). A few reading commands with bounded arguments,
// in the thread's folder only, through the workspaces' git runner
// (workspace/git-run.ts): safeGitArgs, no hooks, no program the repository's
// own config names, no prompt, a timeout and a cap. What git prints is
// cleaned before the AI reads it (scrub-git-output.ts), and the content of a
// secret file (.env, keys) is never shown in a diff.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolRegistrar } from "../mcp/groups.js";
import { AgentError } from "../core/agent-core.ts";
import type { GitCall, GitRunner } from "../workspace/git-run.ts";
import { findContents } from "../workspace/files.ts";
import { isSecretPath } from "../workspace/paths.ts";
import { readable } from "./advisor-guard.ts";
import { scrubGitOutput } from "./scrub-git-output.ts";

export const ADVISOR_GIT_COMMANDS = ["status", "log", "diff", "show", "branch"] as const;
export type AdvisorGitCommand = (typeof ADVISOR_GIT_COMMANDS)[number];

/** What the AI reads of one call, at most. */
export const GIT_OUTPUT_MAX_BYTES = 32 * 1024;
const GIT_READ_MAX_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const LOG_DEFAULT = 20;
const LOG_MAX = 50;

/** A revision as git takes it (a branch, a tag, a hash, `HEAD~2`, `origin/main..HEAD`); never an option. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]{0,99}$/;

const NOT_ADVISOR = "advisor_git is only for Advisor's own session.";
const BAD_REF = "ref must be a branch, tag, commit or range (letters, digits and . _ / @ { } ~ ^ + -), never an option.";
const BAD_PATH = "path must be a file or folder inside this folder, never a secret file.";

/** What the tools run with: the thread's folder (an Advisor thread only), git, and the machine's sensitive folders. */
export type AdvisorGitHooks = {
  /** The folder of the Advisor thread `threadId`; undefined for any other thread. */
  sessionDir(threadId: string): string | undefined;
  git: GitRunner;
  isSensitive(path: string): boolean;
};

export const advisorGitInput = z.object({
  command: z.enum(ADVISOR_GIT_COMMANDS).describe("status | log | diff | show | branch (branch lists every branch with its upstream and how far apart they are)"),
  ref: z.string().max(100).optional().describe("log, diff, show: a branch, tag, commit or range such as origin/main..HEAD"),
  path: z.string().max(300).optional().describe("log, diff: only this file or folder, relative to the session's folder"),
  staged: z.boolean().optional().describe("diff: what is staged instead of what is not"),
  limit: z.number().int().min(1).max(LOG_MAX).optional().describe(`log: how many commits (${LOG_DEFAULT} by default, at most ${LOG_MAX})`),
});

export type AdvisorGitArgs = z.infer<typeof advisorGitInput>;

/** A relative path inside the folder, as a pathspec; undefined when it is not one. */
function pathspec(path: string | undefined): string[] | undefined {
  if (path === undefined || path.trim() === "") return [];
  const p = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (p.startsWith("/") || p.startsWith("-") || p.split("/").some((part) => part === ".." || part === ".git") || isSecretPath(p)) return undefined;
  return [p];
}

/** The git arguments of a call; a string when the call is refused (what the AI reads). */
export function gitArgs(a: AdvisorGitArgs): string[] | string {
  const ref = a.ref?.trim() ?? "";
  if (ref !== "" && !REF.test(ref)) return BAD_REF;
  const paths = pathspec(a.path);
  if (paths === undefined) return BAD_PATH;
  const refs = ref === "" ? [] : [ref];
  switch (a.command) {
    case "status":
      return ["status", "--short", "--branch", "--untracked-files=normal"];
    case "branch":
      return ["branch", "--all", "-vv", "--no-color"];
    case "log":
      return ["log", `--max-count=${a.limit ?? LOG_DEFAULT}`, "--date=short", "--format=%h %ad %an%d %s", "--no-color", ...refs, "--", ...paths];
    case "diff":
      return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(a.staged ? ["--cached"] : []), ...refs, "--", ...paths];
    case "show":
      // A merge shows as its change against the first parent: always plain "diff --git" parts, never a combined diff.
      return ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--diff-merges=first-parent", "--date=short", "--format=%h %ad %an%d%n%n%B", ...(refs.length ? refs : ["HEAD"]), "--", ...paths];
  }
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A name as git quotes it ("…" with C escapes, octal bytes of UTF-8) → the name; undefined when it is not one. */
export function unquoteGitName(quoted: string): string | undefined {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return undefined;
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next] ?? 0);
      i += 1;
    } else return undefined;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The two names of a "diff --git" header's rest ("a/x b/y", either quoted); undefined when they cannot be read. */
function headerNames(rest: string): string[] | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    const a = unquoteGitName(quoted[1] ?? "");
    const b = unquoteGitName(quoted[2] ?? "");
    return a !== undefined && b !== undefined ? [a, b] : undefined;
  }
  const mixed = /^(?:("(?:[^"\\]|\\.)*")|(a\/.+?))\s+(?:("(?:[^"\\]|\\.)*")|(b\/.+))$/.exec(rest);
  if (!mixed) return undefined;
  const a = mixed[1] !== undefined ? unquoteGitName(mixed[1]) : mixed[2];
  const b = mixed[3] !== undefined ? unquoteGitName(mixed[3]) : mixed[4];
  return a !== undefined && b !== undefined ? [a, b] : undefined;
}

/** Whether a diff part with this header line may show its content: false for a secret file, and for a header that cannot be read (fail closed). */
function partShown(header: string): boolean {
  const git = /^diff --git (.+)$/.exec(header);
  if (git) {
    const names = headerNames(git[1] ?? "");
    return names !== undefined && !names.some((n) => isSecretPath(n.replace(/^[ab]\//, "")));
  }
  const combined = /^diff --(?:cc|combined) (.+)$/.exec(header);
  if (combined) {
    const raw = combined[1] ?? "";
    const name = raw.startsWith('"') ? unquoteGitName(raw) : raw;
    return name !== undefined && !isSecretPath(name);
  }
  return false;
}

/** A diff without the content of secret files: each such part, or one whose header cannot be read, keeps only its header line. */
export function withoutSecretFiles(diff: string): string {
  const out: string[] = [];
  let hiding = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --")) {
      hiding = !partShown(line);
      out.push(line);
      if (hiding) out.push("(a secret file, or one whose name cannot be read: its content is not shown)");
      continue;
    }
    if (!hiding) out.push(line);
  }
  return out.join("\n");
}

function text(value: string, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: value }] };
}

/** Runs one call of advisor_git in `root`. */
export async function runAdvisorGit(git: GitRunner, root: string, a: AdvisorGitArgs): Promise<CallToolResult> {
  const args = gitArgs(a);
  if (typeof args === "string") return text(args, true);
  const call: GitCall = { args, kind: "read", timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_READ_MAX_BYTES, partial: true };
  try {
    const out = await git(root, call);
    let printed = out.stdout.toString("utf8");
    if (a.command === "diff" || a.command === "show") printed = withoutSecretFiles(printed);
    const cut = out.capped || out.timedOut ? "\n… (git's output was cut)" : "";
    const body = printed.trim() === "" ? "(git printed nothing)" : printed;
    return text(scrubGitOutput(body + cut, { root, maxBytes: GIT_OUTPUT_MAX_BYTES }));
  } catch (err) {
    const why = err instanceof AgentError ? [err.message, err.subject].filter((s) => s !== "").join(": ") : "git could not run";
    return text(scrubGitOutput(`git: ${why}`, { root, maxBytes: GIT_OUTPUT_MAX_BYTES }), true);
  }
}

/** Matching lines advisor_grep gives at most. */
export const GREP_MATCHES_MAX = 100;
const NOT_ADVISOR_GREP = "advisor_grep is only for Advisor's own session.";

export const advisorGrepInput = z.object({
  query: z.string().min(1).max(200).describe("What to look for in the files of the session's folder"),
  regex: z.boolean().optional().describe("query is an extended regular expression"),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  limit: z.number().int().min(1).max(GREP_MATCHES_MAX).optional().describe(`matching lines at most (${GREP_MATCHES_MAX})`),
});

export type AdvisorGrepArgs = z.infer<typeof advisorGrepInput>;

/**
 * Matching lines in the folder's files (git grep of the workspaces, files git
 * ignores left out): never a secret file or one in a sensitive folder, by
 * its name or where its links lead, nor a file reached through a link out
 * of the folder; each line cut, the whole bounded, secrets hidden.
 */
export async function runAdvisorGrep(git: GitRunner, root: string, a: AdvisorGrepArgs, isSensitive: (path: string) => boolean): Promise<CallToolResult> {
  try {
    const r = await findContents(git, root, { query: a.query, regex: a.regex ?? false, caseSensitive: a.caseSensitive ?? false, wholeWord: a.wholeWord ?? false, limit: a.limit ?? GREP_MATCHES_MAX }, isSensitive);
    const lines: string[] = [];
    for (const file of r.files) {
      if (!readable(file.path, root, isSensitive)) continue;
      for (const m of file.matches) lines.push(`${file.path}:${m.line}: ${m.text}`);
    }
    const cut = r.truncated || r.timedOut ? "\n… (more matches were left out)" : "";
    const body = lines.length === 0 ? "(no match)" : lines.join("\n");
    return text(scrubGitOutput(body + cut, { root, maxBytes: GIT_OUTPUT_MAX_BYTES }));
  } catch (err) {
    const why = err instanceof AgentError ? [err.message, err.subject].filter((s) => s !== "").join(": ") : "the search could not run";
    return text(scrubGitOutput(`search: ${why}`, { root, maxBytes: GIT_OUTPUT_MAX_BYTES }), true);
  }
}

/** Registers advisor_grep (see registerAdvisorGitTool for `bound`). */
export function registerAdvisorGrepTool(server: ToolRegistrar, bound?: { hooks: AdvisorGitHooks; threadId: string }): void {
  server.registerTool(
    "advisor_grep",
    {
      title: "Search the files of Advisor's folder",
      description:
        "Advisor's session only: lines matching a text or regular expression in the session's folder (files git ignores, secret files and links out of the folder are left out; secrets in lines are hidden).",
      inputSchema: advisorGrepInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const root = bound?.hooks.sessionDir(bound.threadId);
      if (!bound || root === undefined) return text(NOT_ADVISOR_GREP, true);
      return runAdvisorGrep(bound.hooks.git, root, args, (p) => bound.hooks.isSensitive(p));
    },
  );
}

/** Registers advisor_git. `bound`: what it runs with and the thread it runs for; absent where the tool is only listed (`tunelo mcp`). */
export function registerAdvisorGitTool(server: ToolRegistrar, bound?: { hooks: AdvisorGitHooks; threadId: string }): void {
  server.registerTool(
    "advisor_git",
    {
      title: "Read git in Advisor's folder",
      description:
        "Advisor's session only: git status, log, diff, show or branch in the session's folder, read only. Secret files' content is never shown; paths of the machine and passwords in URLs are hidden.",
      inputSchema: advisorGitInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const root = bound?.hooks.sessionDir(bound.threadId);
      if (!bound || root === undefined) return text(NOT_ADVISOR, true);
      return runAdvisorGit(bound.hooks.git, root, args);
    },
  );
}
