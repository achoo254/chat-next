// The preview line of a session in the thread list (ThreadSummary.preview):
// the last user or AI text as one plain line, "Running: <tool>" while a tool
// runs, sent with the thread list event and kept over a restart.
import { Decision, type ThreadSummary, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { PREVIEW_MAX, previewLine } from "../src/core/preview.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };
const done = (n: number) => (items: Parameters<typeof byCase>[0]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;

describe("preview line", () => {
  it("drops markdown and folds the text into one line", () => {
    expect(previewLine("# Title\n\nSome **bold** and _soft_ `code`,\n- a [link](https://x.example) item\n> quoted")).toBe(
      "Title Some bold and soft code, a link item quoted",
    );
    expect(previewLine("```ts\nconst a = 1;\n```\nDone.")).toBe("const a = 1; Done.");
    expect(previewLine("![diagram](a.png) see 1. first")).toBe("diagram see 1. first");
    expect(previewLine("snake_case_name stays")).toBe("snake_case_name stays");
    expect(previewLine("   \n  ")).toBe("");
  });

  it("cuts at the limit with an ellipsis, never through an emoji", () => {
    const long = "😀".repeat(200);
    const line = previewLine(long);
    expect([...line]).toHaveLength(PREVIEW_MAX);
    expect(line.endsWith("…")).toBe(true);
    expect(line.includes("�")).toBe(false);
    expect(previewLine("a".repeat(PREVIEW_MAX))).toBe("a".repeat(PREVIEW_MAX));
  });
});

describe("session preview in the thread list", () => {
  it("follows the last message, shows the running tool, and survives a restart", async () => {
    const { core, work, dataDir, home } = makeCore([fakeProvider()]);
    const statuses: ThreadSummary[] = [];
    core.onStatus((s) => statuses.push(s));

    const t = await core.create({ provider: "fake", model: "", dir: work, text: "**Fix** the\nlogin page", consent, device: "test" });
    // The user's message first, until the AI answers.
    expect(statuses.some((s) => s.preview === "Fix the login page")).toBe(true);
    await until(core, t.id, done(1));
    expect(core.list()[0]?.preview).toBe("echo: Fix the");
    expect(core.list()[0]?.previewTool).toBe("");

    // A tool while it runs: announced with its name, gone once it ended.
    statuses.length = 0;
    await core.send(t.id, "ask ls", "");
    const items = await until(core, t.id, (xs) => byCase(xs, "approval").length === 1);
    const approval = byCase(items, "approval")[0];
    if (!approval) throw new Error("no approval");
    core.respond(t.id, approval.id, approval.revision, { decision: Decision.ALLOW }, "test");
    await until(core, t.id, done(2));
    expect(statuses.some((s) => s.previewTool === "Shell")).toBe(true);
    expect(statuses.at(-1)?.previewTool).toBe("");
    expect(core.list()[0]?.preview).toBe("ran ls");
    await core.stop();

    // Loaded again from its journal.
    const again = makeCore([fakeProvider()], { dataDir, home });
    expect(again.core.list()[0]?.preview).toBe("ran ls");
    await again.core.stop();
  });
});
