// An AI's tool call naming a folder macOS protects that tunelo may not enter
// yet never leaves the conversation hanging on a macOS prompt nobody at the
// machine answers: Claude and agy ask the user on a card first (and macOS
// only once allowed, for a bounded time), and a call that runs anyway stops
// the turn after MAC_STALL_MS, so the next message reaches the AI.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAC_STALL_MS } from "../src/core/agent-core.ts";
import { answerPermission, type PermissionContext } from "../src/providers/antigravity/permissions.ts";
import type { AcpPermissionParams } from "../src/providers/acp/acp-session.ts";
import { macFolderHook } from "../src/providers/claude/index.ts";
import type { ApprovalAnswer, ApprovalRequest, AskUser } from "../src/providers/types.ts";
import { MAC_ASK_IN_TURN_MS, type AskOutcome, type MacFolderGate, macFolderBeforeCall } from "../src/safety/mac-folders.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, until } from "./harness.ts";

const HOME = "/Users/an";
const DOCS = `${HOME}/Documents`;

/** A gate where ~/Documents is not granted until `grant()`, and asking macOS answers `outcome`. */
function gate(outcome: AskOutcome = "granted") {
  let granted = false;
  const asked: string[] = [];
  const g: MacFolderGate = {
    ungrantedIn: (text) => (!granted && (text.includes(DOCS) || text.includes("~/Documents")) ? DOCS : undefined),
    askAndWait: async (folder) => {
      asked.push(folder);
      if (outcome === "granted") granted = true;
      return outcome;
    },
  };
  return { g, asked, grant: () => (granted = true) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Claude's PreToolUse hook", () => {
  const input = (tool_input: Record<string, unknown>) =>
    ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input, tool_use_id: "tu", permission_mode: "acceptEdits", session_id: "s", transcript_path: "", cwd: "/" }) as never;
  const decide = async (hook: ReturnType<typeof macFolderHook>, tool_input: Record<string, unknown>) =>
    ((await hook(input(tool_input), "tu", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

  it("sends a call naming a folder not granted to the device as a card, in any mode, and leaves the rest alone", async () => {
    const { g, grant } = gate();
    const hook = macFolderHook({ dir: "/work", macFolders: g });
    expect(await decide(hook, { file_path: `${DOCS}/a.md` })).toBe("ask");
    expect(await decide(hook, { command: "ls ~/Documents" })).toBe("ask");
    expect(await decide(hook, { file_path: "/work/a.md" })).toBeUndefined();
    grant();
    expect(await decide(hook, { file_path: `${DOCS}/a.md` })).toBeUndefined();
    expect(await decide(macFolderHook({ dir: "/work" }), { file_path: `${DOCS}/a.md` })).toBeUndefined();
  });
});

describe("macFolderBeforeCall", () => {
  it("lets the call run once macOS allows it; otherwise the AI reads why and goes on", async () => {
    expect(await macFolderBeforeCall(gate("granted").g, DOCS)).toBeUndefined();
    expect(await macFolderBeforeCall(gate("denied").g, DOCS)).toMatch(/does not let tunelo into \/Users\/an\/Documents/);
    expect(await macFolderBeforeCall(gate("unanswered").g, DOCS)).toMatch(/nobody answered/);
    expect(MAC_ASK_IN_TURN_MS).toBeLessThan(MAC_STALL_MS);
  });
});

describe("agy's permission request", () => {
  const params = (rawInput: Record<string, unknown>): AcpPermissionParams => ({
    sessionId: "s1",
    toolCall: { toolCallId: "call_1", name: "run_command", kind: "execute", title: "Run", rawInput },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  function context(decision: ApprovalAnswer["decision"], macFolders: MacFolderGate) {
    const cards: ApprovalRequest[] = [];
    const rules = new Set<string>();
    const askUser = (async (req: ApprovalRequest) => {
      cards.push(req);
      return { decision };
    }) as unknown as AskUser;
    const ctx: PermissionContext = { dir: "/work", askUser, isSensitive: () => false, rules, onRule: () => undefined, macFolders };
    return { ctx, cards, rules };
  }
  const run = (ctx: PermissionContext, rawInput: Record<string, unknown>) => answerPermission(params(rawInput), ctx, new AbortController().signal);

  it("names the folder on the card and asks macOS only once allowed; never a rule for the session", async () => {
    const { g, asked } = gate("granted");
    const { ctx, cards, rules } = context("allow-session", g);
    expect(await run(ctx, { CommandLine: `cat ${DOCS}/notes.txt` })).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(cards.map((c) => c.macFolder)).toEqual([DOCS]);
    expect(asked).toEqual([DOCS]);
    expect(rules.size).toBe(0);
  });

  it("refuses the call when the user says no, or macOS refuses or nobody answers it", async () => {
    const no = gate("granted");
    const denied = context("deny", no.g);
    expect(await run(denied.ctx, { CommandLine: "ls ~/Documents" })).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(no.asked).toEqual([]);
    for (const outcome of ["denied", "unanswered"] as const) {
      const { ctx } = context("allow", gate(outcome).g);
      expect(await run(ctx, { CommandLine: "ls ~/Documents" })).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    }
  });
});

describe("a tool call held in a folder not granted", () => {
  it("stops the turn after MAC_STALL_MS with an error naming the folder, and the session takes the next message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { g } = gate("unanswered");
    const { core, work } = makeCore([fakeProvider()], { more: { macFolders: g } });
    const t = await core.create({ provider: "fake", model: "", dir: work, text: `stuck ${join(DOCS, "a.md")}`, consent: { sensitive: false, projectSettings: false }, device: "test" });
    await vi.waitFor(() => expect(core.snapshot(t.id).some((i) => i.body.case === "toolCall")).toBe(true));
    await vi.advanceTimersByTimeAsync(MAC_STALL_MS - 1_000);
    expect(core.snapshot(t.id).some((i) => i.body.case === "error")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    const items = await until(core, t.id, (all) => all.some((i) => i.body.case === "turn" && i.body.value.state !== 1));
    const error = items.find((i) => i.body.case === "error");
    expect(error?.body.case === "error" && error.body.value.macFolder).toBe(DOCS);
    await core.send(t.id, "hello again", "m2");
    await until(core, t.id, (all) => all.some((i) => i.body.case === "text" && i.body.value.text === "echo: hello again"));
  });

  it("is left alone while a card waits for the user, and once the folder is granted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { g, grant } = gate("unanswered");
    const { core, work } = makeCore([fakeProvider()], { more: { macFolders: g } });
    const t = await core.create({ provider: "fake", model: "", dir: work, text: `stuck ${join(DOCS, "a.md")}`, consent: { sensitive: false, projectSettings: false }, device: "test" });
    await vi.waitFor(() => expect(core.snapshot(t.id).some((i) => i.body.case === "toolCall")).toBe(true));
    grant();
    await vi.advanceTimersByTimeAsync(MAC_STALL_MS * 2);
    expect(core.snapshot(t.id).some((i) => i.body.case === "error")).toBe(false);
    await core.interrupt(t.id);
  });
});
