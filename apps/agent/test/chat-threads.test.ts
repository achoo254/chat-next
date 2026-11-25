// The AI session of a Chat conversation: one thread per chat, working in a
// folder of tunelo's own data when the device gives none, which is not
// sensitive though the rest of tunelo's data is; its chat id survives a
// restart, and its folder is no project the machine suggests.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import { type AgentCore, chatSessionsDir } from "../src/core/agent-core.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";

const none = { sensitive: false, projectSettings: false };
const posix = process.platform !== "win32";
const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

/** A core laid out like the machine's: its data inside tunelo's config folder, which is sensitive except for the chats' folders. */
function setup(configDir = tempDir("tunelo-config-")) {
  const dataDir = join(configDir, "data");
  const m = makeCore([fakeProvider()], {
    dataDir,
    more: { isSensitive: createSensitiveCheck({ configDir, except: [chatSessionsDir(dataDir)] }) },
  });
  cores.push(m.core);
  return { ...m, configDir };
}

const chat = { chatId: 4242n, title: "Nhóm bạn", app: "telegram" };

describe("a Chat conversation's AI thread", () => {
  test("opens without a folder in its own folder of tunelo's data, with the chat id and a title naming the chat", async () => {
    const { core, dataDir, configDir } = setup();
    const thread = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    const folder = join(chatSessionsDir(dataDir), "4242");
    expect(existsSync(folder)).toBe(true);
    if (posix) expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(thread.chatId).toBe(4242n);
    expect(thread.title).toBe("AI · Nhóm bạn");
    expect(statSync(thread.dir).ino).toBe(statSync(folder).ino);
    // The rest of tunelo's data stays sensitive.
    const sensitive = createSensitiveCheck({ configDir, except: [chatSessionsDir(dataDir)] });
    expect(sensitive(thread.dir)).toBe(false);
    expect(sensitive(join(configDir, "config.json"))).toBe(true);
    expect(sensitive(dataDir)).toBe(true);
  });

  test("gives the thread there is for the same chat instead of a second one", async () => {
    const { core } = setup();
    const first = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    const again = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "laptop", chat: { ...chat, title: "Renamed" } });
    expect(again.id).toBe(first.id);
    expect(core.list().filter((s) => s.chatId === 4242n)).toHaveLength(1);
    // Another chat gets its own thread and folder.
    const other = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat: { chatId: 7n, title: "", app: "" } });
    expect(other.id).not.toBe(first.id);
    expect(other.title).toBe("AI");
    expect(other.dir).not.toBe(first.dir);
  });

  test("two requests for the same chat at once still make one thread", async () => {
    const { core } = setup();
    const [a, b] = await Promise.all([
      core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat }),
      core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "laptop", chat }),
    ]);
    expect(a.id).toBe(b.id);
    expect(core.list()).toHaveLength(1);
  });

  test("a folder given is used as before, and a first message names the thread", async () => {
    const { core, work } = setup();
    const thread = await core.create({ provider: "fake", model: "", dir: work, text: "summarize this chat", consent: none, device: "phone", chat });
    expect(thread.dir).toBe(work);
    expect(thread.title).toBe("summarize this chat");
    expect(thread.chatId).toBe(4242n);
  });

  test("refuses a chat id that is not positive", async () => {
    const { core } = setup();
    await expect(core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat: { chatId: 0n, title: "", app: "" } })).rejects.toMatchObject({
      reason: ErrorReason.UNSUPPORTED_REQUEST,
    });
    expect(core.list()).toHaveLength(0);
  });

  test("keeps the chat id through a restart, and an archived chat thread no longer counts as the chat's", async () => {
    const configDir = tempDir("tunelo-config-");
    const { core } = setup(configDir);
    const thread = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    const plain = await core.create({ provider: "fake", model: "", dir: tempDir("project-"), text: "", consent: none, device: "phone" });
    expect(plain.chatId).toBe(0n);
    await core.stop();

    const { core: restarted } = setup(configDir);
    const back = restarted.list().find((s) => s.id === thread.id);
    expect(back?.chatId).toBe(4242n);
    const again = await restarted.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    expect(again.id).toBe(thread.id);

    restarted.setArchived(thread.id, true);
    const fresh = await restarted.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    expect(fresh.id).not.toBe(thread.id);
  });

  test("its folder is not among the recent folders, while the thread stays in the list", async () => {
    const { core, work } = setup();
    const thread = await core.create({ provider: "fake", model: "", dir: "", text: "", consent: none, device: "phone", chat });
    await core.create({ provider: "fake", model: "", dir: work, text: "", consent: none, device: "phone" });
    expect(core.recentDirs()).toEqual([work]);
    expect(core.list().some((s) => s.id === thread.id)).toBe(true);
  });
});
