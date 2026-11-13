// The slash commands of a thread whose session has not opened (a thread run
// in the terminal, or one waiting for its first message): learned from its AI
// for the folder, as the thread's session would load it, then told to devices.
// An AI that cannot list them leaves the last commands any session reported.
import { describe, expect, it } from "vitest";
import type { CommandsRequest, SlashCommand } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore } from "./harness.ts";

const SKILL: SlashCommand = { name: "ak-fix", description: "Fix bugs", argumentHint: "", builtin: false };

/** A fake AI that lists `list` for any folder and records what it was asked. */
function listingProvider(list: SlashCommand[]) {
  const asked: CommandsRequest[] = [];
  const provider = Object.assign(fakeProvider(), {
    listCommands: (req: CommandsRequest) => {
      asked.push(req);
      return Promise.resolve(list);
    },
  });
  return { provider, asked };
}

const changed = (core: ReturnType<typeof makeCore>["core"], threadId: string) =>
  new Promise<void>((resolve) => {
    const off = core.onInfo((id) => {
      if (id !== threadId) return;
      off();
      resolve();
    });
  });

describe("commands of a thread with no session yet", () => {
  it("learns them from its AI for the folder, with the folder's own settings when the thread loads them, and tells devices", async () => {
    const { provider, asked } = listingProvider([SKILL]);
    const { core, work } = makeCore([provider], { trusted: () => true });
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: true }, device: "d" });
    const told = changed(core, t.id);
    expect(core.info(t.id).commands).toEqual([]);
    await told;
    expect(core.info(t.id).commands.map((c) => c.name)).toEqual(["ak-fix"]);
    expect(asked).toEqual([{ dir: work, projectSettings: true }]);
    // Known for the folder: not asked again.
    core.info(t.id);
    expect(asked).toHaveLength(1);
  });

  it("an AI that cannot list them: the last commands any session reported", async () => {
    const { core, work } = makeCore([fakeProvider()]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: false }, device: "d" });
    expect(core.info(t.id).commands).toEqual([]);
  });
});
