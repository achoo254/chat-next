// The hook side of the privacy filter: only allowlisted fields pass, paths
// lose the home folder, secret files keep only their name and no content,
// content is redacted before it is cut, a project without content keeps
// none, and a tool result of megabytes costs about as little as a short one.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { type HookFilterContext, filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import { COMMON_HOOK_FIELDS, HOOK_EVENT_FIELDS } from "../../src/observatory/privacy/hook-allowlist.ts";
import { EXCERPT_MAX_CHARS, REDACT_WINDOW_CHARS } from "../../src/observatory/privacy/privacy-text.ts";
import { FAKE_CWD, FAKE_HOME, FAKE_IDENTIFIERS, HOOK_PAYLOADS, isFakeSensitive } from "./observatory-payloads.ts";

// Both passes at once, as a source inside the agent: two-pass-redaction.test.ts covers the hook's pass and the agent's apart.
const ctx: HookFilterContext = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true, stage: "final" };
const DERIVED = ["target", "input_bytes", "output_bytes", "git_op", "git_sha", "git_kind", "git_branch", "tool_use_ids", "prompt_length", "project_key"];
const JWT = `eyJ${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;

function filter(event: string, payload: Record<string, unknown>, over: Partial<HookFilterContext> = {}): FilteredHookRecord {
  const r = filterHookEvent(event, payload, { ...ctx, ...over }, 1_000);
  if (!r) throw new Error(`${event} was dropped`);
  return r;
}

describe("the hook allowlist", () => {
  it("keeps only allowlisted fields of every event, and no identifying value", () => {
    for (const [event, payload] of Object.entries(HOOK_PAYLOADS)) {
      const r = filter(event, payload);
      const allowed = new Set([...Object.keys(COMMON_HOOK_FIELDS), ...Object.keys(HOOK_EVENT_FIELDS[event] ?? {}), ...DERIVED]);
      for (const key of [...Object.keys(r.f), ...Object.keys(r.c ?? {})]) expect(allowed, `${event}.${key}`).toContain(key);
      expect(r.f).not.toHaveProperty("transcript_path");
      expect(r.f).not.toHaveProperty("agent_transcript_path");
      expect(r.f).not.toHaveProperty("user_email");
      const text = JSON.stringify(r);
      for (const id of FAKE_IDENTIFIERS) expect(text, `${event} keeps ${id}`).not.toContain(id);
    }
  });

  it("keeps neither the home folder nor the account name in content, in any form a tool prints them", () => {
    const forms = [FAKE_HOME, FAKE_HOME.replaceAll("\\", "/"), "/c/Users/example-user/work", "D:\\backup\\EXAMPLE-USER\\a.txt", "whoami: example-user"];
    const r = filter("PostToolUse", { ...HOOK_PAYLOADS.PostToolUse, tool_response: { stdout: forms.join("\n") } });
    const kept = r.c?.tool_response ?? "";
    expect(kept).toContain("~");
    expect(kept).toContain("[user]");
    expect(kept.toLowerCase()).not.toContain("example-user");
    const inHome = filter("PreToolUse", { ...HOOK_PAYLOADS.PreToolUse, tool_input: { file_path: join(FAKE_HOME, "notes.txt") } });
    expect(inHome.f.target).toBe("~/notes.txt");
  });

  it("never rewrites a short or ordinary account name, nor structured fields", () => {
    const home = process.platform === "win32" ? "C:\\Users\\dev" : "/home/dev";
    const dev: HookFilterContext = { home, isSensitive: isFakeSensitive, contentAllowed: true, stage: "final" };
    const payload = {
      session_id: "s",
      cwd: join("D:", "work", "dev-tools", "dev"),
      tool_name: "Bash",
      tool_input: { command: "npm run dev" },
      tool_response: { stdout: "> dev\nstarted dev server", gitOperation: { commit: { sha: "abc1234", kind: "commit", branch: "dev" } } },
    };
    const r = filterHookEvent("PostToolUse", payload, dev, 1);
    expect(r?.f.git_branch).toBe("dev");
    expect(String(r?.f.cwd)).toMatch(/dev-tools[\\/]dev$/);
    expect(r?.c?.tool_input).toContain("npm run dev");
    expect(r?.c?.tool_response).toContain("started dev server");
    // A long, unusual name of the logged-in user (an account renamed since its home folder was made) is hidden in content.
    const renamed = filterHookEvent("Stop", { session_id: "s", cwd: "D:\\w", last_assistant_message: "whoami: desktop\\example-renamed" }, { ...dev, accountNames: ["dev", "example-renamed"] }, 1);
    expect(renamed?.c?.last_assistant_message).toBe("whoami: desktop\\[user]");
  });

  it("carries the project key it is given, worked out from the real folder", () => {
    expect(filter("SessionStart", HOOK_PAYLOADS.SessionStart ?? {}, { projectKey: "github.com/example/app" }).f.project_key).toBe("github.com/example/app");
  });

  it("drops events it does not keep and payloads that are no object", () => {
    expect(filterHookEvent("MessageDisplay", { ...HOOK_PAYLOADS.Stop, delta: "text" }, ctx, 1)).toBeUndefined();
    expect(filterHookEvent("constructor", {}, ctx, 1)).toBeUndefined();
    expect(filterHookEvent("Stop", "text", ctx, 1)).toBeUndefined();
    expect(filterHookEvent("Stop", [1], ctx, 1)).toBeUndefined();
  });

  it("writes the home folder as ~ and keeps short labels", () => {
    const r = filter("PostToolUse", HOOK_PAYLOADS.PostToolUse ?? {});
    expect(String(r.f.cwd)).toMatch(/^~[\\/]work[\\/]example-app$/);
    expect(r.f.target).toBe("vitest");
    expect(r.f).toMatchObject({ git_op: "commit", git_sha: "abc1234def", git_kind: "commit", git_branch: "feat/example", duration_ms: 569 });
    expect(filter("PreToolUse", HOOK_PAYLOADS.PreToolUse ?? {}).f.target).toBe("src/app.ts");
    expect(filter("PostToolBatch", HOOK_PAYLOADS.PostToolBatch ?? {}).f.tool_use_ids).toEqual(["toolu_0001", "toolu_0002"]);
    const mcp = filter("PreToolUse", { ...HOOK_PAYLOADS.PreToolUse, tool_name: "mcp__github__create_issue", tool_input: { title: "x" } });
    expect(mcp.f.target).toBe("github › create_issue");
    const web = filter("PreToolUse", { ...HOOK_PAYLOADS.PreToolUse, tool_name: "WebFetch", tool_input: { url: "https://docs.example.com/a?token=abc" } });
    expect(web.f.target).toBe("docs.example.com");
  });
});

describe("secret files", () => {
  const envPath = join(FAKE_CWD, ".env");
  const envBody = "DATABASE_PASSWORD=example-password-value";

  it("keeps a .env file's name only, never its content", () => {
    const r = filter("PostToolUse", { ...HOOK_PAYLOADS.PreToolUse, tool_name: "Read", tool_input: { file_path: envPath }, tool_response: { file: { content: envBody } } });
    expect(r.f.target).toBe(".env");
    expect(r.c).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("example-password-value");
  });

  it("keeps no content of a shell command that reads one, nor of a search for one", () => {
    const cat = filter("PostToolUse", { ...HOOK_PAYLOADS.PostToolUse, tool_input: { command: "cat .env" }, tool_response: { stdout: envBody } });
    expect(cat.c).toBeUndefined();
    const grep = filter("PostToolUse", { ...HOOK_PAYLOADS.PreToolUse, tool_name: "Grep", tool_input: { pattern: "PASSWORD", path: join(FAKE_HOME, ".ssh") }, tool_response: envBody });
    expect(grep.c).toBeUndefined();
    expect(grep.f.target).toBe(".ssh");
  });

  it("keeps only the name of an instructions file in a sensitive folder", () => {
    const r = filter("InstructionsLoaded", { ...HOOK_PAYLOADS.InstructionsLoaded, file_path: join(FAKE_HOME, ".claude", "CLAUDE.md") });
    expect(r.f.file_path).toBe("CLAUDE.md");
  });
});

describe("content", () => {
  it("hides credentials a command prints, by shape and by name", () => {
    const half = (a: string, b: string): string => a + b;
    const keys = [half("sk-ant-", "api03-EXAMPLEexample0123456789abcdef"), half("ghp_", "EXAMPLEexample0123456789EXAMPLEexam"), half("AKIA", "EXAMPLE012345678")];
    const urlPass = half("Sup3r", "S3cretExample");
    const dbUrl = `${half("post", "gres")}://app:${urlPass}@db.example:5432/app`;
    const pemBody = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU";
    const pem = [half("-----BEGIN OPENSSH ", "PRIVATE KEY-----"), pemBody, half("-----END OPENSSH ", "PRIVATE KEY-----")].join("\n");
    const stdout = [`ANTHROPIC_API_KEY=${keys[0]}`, `GITHUB_TOKEN=${keys[1]}`, `AWS_ACCESS_KEY_ID=${keys[2]}`, `DATABASE_URL=${dbUrl}`, "DB_PASSWORD=example-db-password", pem].join("\n");
    const kept = filter("PostToolUse", { ...HOOK_PAYLOADS.PostToolUse, tool_input: { command: "printenv" }, tool_response: { stdout } }).c?.tool_response ?? "";
    for (const secret of [...keys, urlPass, "example-db-password", pemBody]) expect(kept).not.toContain(secret);
    expect(kept).toContain("://app:[hidden]@db.example");
    const prompt = filter("UserPromptSubmit", { ...HOOK_PAYLOADS.UserPromptSubmit, prompt: `use this key ${keys[0]}` }).c?.prompt;
    expect(prompt).toBe("use this key [hidden]");
  });

  it("is redacted before it is cut: a token across the 2 KB boundary never shows", () => {
    for (const shift of [-40, -10, -3, 0, 5]) {
      const prompt = `${"a".repeat(EXCERPT_MAX_CHARS + shift)}${JWT} tail`;
      const r = filter("UserPromptSubmit", { ...HOOK_PAYLOADS.UserPromptSubmit, prompt });
      const kept = r.c?.prompt ?? "";
      expect(kept.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
      expect(kept).not.toMatch(/eyJa{4}/);
      expect(r.f.prompt_length).toBe(prompt.length);
    }
    const bearer = filter("UserPromptSubmit", { ...HOOK_PAYLOADS.UserPromptSubmit, prompt: `${"b".repeat(EXCERPT_MAX_CHARS - 12)}Bearer example-bearer-value` });
    expect(bearer.c?.prompt).not.toContain("example-bearer");
  });

  it("hides the known secret values it is given", () => {
    const r = filter("Stop", { ...HOOK_PAYLOADS.Stop, last_assistant_message: "the key is example-known-secret-1" }, { known: ["example-known-secret-1"] });
    expect(r.c?.last_assistant_message).toBe("the key is [hidden]");
  });

  it("keeps no text at all for a project with content off, but keeps the labels", () => {
    for (const [event, payload] of Object.entries(HOOK_PAYLOADS)) {
      const r = filter(event, payload, { contentAllowed: false });
      expect(r.c, event).toBeUndefined();
    }
    expect(filter("PostToolUse", HOOK_PAYLOADS.PostToolUse ?? {}, { contentAllowed: false }).f.target).toBe("vitest");
  });

  it("costs a few milliseconds for a tool result of several megabytes", () => {
    const big = { ...HOOK_PAYLOADS.PreToolUse, tool_response: { file: { content: "x".repeat(8 * 1024 * 1024) }, lines: Array.from({ length: 200_000 }, (_, i) => i) } };
    const small = { ...HOOK_PAYLOADS.PreToolUse, tool_response: { file: { content: "x" } } };
    const median = (payload: Record<string, unknown>): number => {
      const runs: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        filterHookEvent("PostToolUse", payload, ctx, 1);
        runs.push(performance.now() - t);
      }
      return runs.sort((a, b) => a - b)[3] ?? 0;
    };
    median(small);
    const bigMs = median(big);
    const r = filter("PostToolUse", big);
    expect(r.c?.tool_response?.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
    expect(filterHookEvent("PostToolUse", big, { ...ctx, stage: "hook" }, 1)?.c?.tool_response?.length).toBeLessThanOrEqual(REDACT_WINDOW_CHARS + 1);
    expect(r.f.output_bytes).toBeGreaterThan(8 * 1024 * 1024);
    // Measuring 8 MB of text natively and walking 200 000 numbers: a few ms, against seconds for a full JSON.stringify and redact.
    expect(bigMs).toBeLessThan(25 + median(small));
  });
});
