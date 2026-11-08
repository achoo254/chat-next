import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PromptState, Role, TurnState } from "@achoo254/chat-proto/remote/remote";
import { ResetReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/threads/journal.ts";
import { wireItem } from "../src/link/wire.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const meta = { provider: "fake", model: "" };

describe("journal", () => {
  it("gives every change a new seq and keeps the latest revision", () => {
    const j = new Journal(join(tempDir(), "j.jsonl"));
    j.put("a", { case: "text", value: { role: Role.USER, text: "hi" } }, meta);
    j.put("b", { case: "status", value: { text: "x" } }, meta);
    j.update("a", (b) => {
      if (b.case === "text") b.value.text = "hi!";
    });
    expect(j.since(0n).map((i) => [i.id, i.seq, i.revision])).toEqual([
      ["b", 2n, 1],
      ["a", 3n, 2],
    ]);
    expect(j.since(2n).map((i) => i.id)).toEqual(["a"]);
  });

  it("cuts a torn last line and keeps appending cleanly", () => {
    const file = join(tempDir(), "j.jsonl");
    const j = new Journal(file);
    j.put("a", { case: "status", value: { text: "one" } }, meta);
    appendFileSync(file, '{"id":"b","seq":"2","bo');
    const again = new Journal(file);
    again.load();
    expect(again.all().map((i) => i.id)).toEqual(["a"]);
    again.put("c", { case: "status", value: { text: "two" } }, meta);
    const reread = new Journal(file);
    reread.load();
    expect(reread.all().map((i) => [i.id, i.seq])).toEqual([
      ["a", 1n],
      ["c", 2n],
    ]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("restart", () => {
  it("expires open prompts, ends open turns and bumps the epoch", async () => {
    const provider = fakeProvider();
    const first = makeCore([provider]);
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "ask ls", consent: { sensitive: false, projectSettings: false }, device: "d" });
    await until(first.core, t.id, (i) => byCase(i, "approval").length > 0);
    const cursor = { $typeName: "remote.v1.Cursor" as const, epoch: first.core.epoch, seq: first.core.lastSeq(t.id) };
    // Simulate a crash: a new core on the same data without stopping the old one.
    const second = makeCore([fakeProvider()], { dataDir: first.dataDir, home: first.home });
    expect(second.core.epoch).toBe(first.core.epoch + 1n);
    const items = second.core.snapshot(t.id);
    expect(byCase(items, "approval")[0]?.body.value.state).toBe(PromptState.EXPIRED);
    expect(byCase(items, "turn")[0]?.body.value.state).toBe(TurnState.INTERRUPTED);
    const r = second.core.subscribe(t.id, cursor);
    expect(r.resume).toEqual({ kind: "reset", reason: ResetReason.EPOCH_CHANGED });
    await first.core.stop();
  });
});

describe("statusline after restart", () => {
  it("keeps the thread's mode and commands, and offers the last commands to new threads", async () => {
    const first = makeCore([fakeProvider()]);
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "hi", consent: { sensitive: false, projectSettings: false }, device: "d" });
    await until(first.core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    await first.core.stop();
    const second = makeCore([fakeProvider()], { dataDir: first.dataDir, home: first.home });
    const info = second.core.info(t.id);
    expect(info.permissionMode).toBe("default");
    expect(info.commands.map((c) => c.name)).toEqual(["review"]);
  });
});

describe("wire", () => {
  it("shortens big outputs and diffs, keeping the stored item whole", () => {
    const j = new Journal(join(tempDir(), "j.jsonl"));
    const big = j.put("r", { case: "toolResult", value: { toolId: "t", ok: true, output: "x".repeat(10_000) } }, meta);
    const w = wireItem(big);
    expect(w.body.case === "toolResult" && w.body.value.output.length).toBe(4000);
    expect(w.body.case === "toolResult" && w.body.value.truncated).toBe(true);
    expect(big.body.case === "toolResult" && big.body.value.output.length).toBe(10_000);
    const diff = j.put("d", { case: "diff", value: { path: "a", unified: Array(300).fill("+x").join("\n") } }, meta);
    const wd = wireItem(diff);
    expect(wd.body.case === "diff" && wd.body.value.unified.split("\n").length).toBe(120);
  });
});
