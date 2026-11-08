import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AppName } from "../../src/identity/session.ts";
import { SessionExpiredError } from "../../src/identity/session.ts";
import { type ToolGroup, toolGroup } from "../../src/mcp/groups.ts";
import { RemoteProxy, type RemoteAccess } from "../../src/mcp/remote-proxy.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*/;
const jwt = (n: string) => `eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ${n}.c2ln${n}`;

const chat = toolGroup("chat") as ToolGroup;
/** Localman's group, pointed at the fake's tools. */
const localman: ToolGroup = { name: "localman", app: "localman", allowedTools: ["list_chats"], writeTools: [], twoStepTools: [] };

let apps: Record<"chat" | "localman", FakeMcpApp>;
let tokens: Record<string, string>;
let forgotten: [AppName, string][];
let now: number;
let signedIn: boolean;

const access: RemoteAccess = {
  endpoint: (app) => apps[app as "chat" | "localman"].url,
  token: async (app) => {
    if (!signedIn) throw new SessionExpiredError("This machine is not signed in: run `tunelo login` on it.");
    return tokens[app] ?? "";
  },
  forget: async (app, token) => {
    forgotten.push([app, token]);
    tokens[app] = `${token}-new`;
  },
};

function proxy(): RemoteProxy {
  return new RemoteProxy(access, { now: () => now });
}

const text = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join("");

beforeEach(async () => {
  apps = { chat: await startFakeMcpApp(), localman: await startFakeMcpApp() };
  tokens = { chat: jwt("chat"), localman: jwt("localman") };
  apps.chat.accepted.add(tokens.chat ?? "");
  apps.localman.accepted.add(tokens.localman ?? "");
  forgotten = [];
  now = 1_000_000;
  signedIn = true;
});

afterEach(async () => {
  await apps.chat.close();
  await apps.localman.close();
});

describe("remote MCP proxy", () => {
  test("lists only the group's allowed tools, cached ten minutes", async () => {
    const p = proxy();
    const tools = await p.tools(chat);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_chats", "send_message"]);
    expect(tools.find((t) => t.name === "send_message")?.inputSchema).toMatchObject({ properties: { chat_id: {}, text: {} } });
    const requests = apps.chat.seen.length;
    await p.tools(chat);
    expect(apps.chat.seen.length).toBe(requests);
    now += 10 * 60_000 + 1;
    await p.tools(chat);
    expect(apps.chat.seen.length).toBeGreaterThan(requests);
    await p.close();
  });

  test("each group carries only its own app's token", async () => {
    const p = proxy();
    await p.call(chat, "list_chats", {});
    await p.call(localman, "list_chats", {});
    expect(new Set(apps.chat.seen)).toEqual(new Set([tokens.chat]));
    expect(new Set(apps.localman.seen)).toEqual(new Set([tokens.localman]));
    await p.close();
  });

  test("runs a tool and never hands back a token, even one the server echoes", async () => {
    const p = proxy();
    const result = await p.call(chat, "send_message", { chat_id: 7, text: "hi" });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('"sent":"hi"');
    expect(text(result)).not.toMatch(JWT);
    expect(JSON.stringify(result)).not.toContain(tokens.chat);
    expect(apps.chat.calls).toEqual([{ name: "send_message", args: { chat_id: 7, text: "hi" } }]);
    await p.close();
  });

  test("refuses a tool outside the group without asking the server", async () => {
    const p = proxy();
    const result = await p.call(chat, "delete_messages", { chat_id: 7 });
    expect(result.isError).toBe(true);
    expect(apps.chat.seen).toEqual([]);
    await p.close();
  });

  test("a 401 refreshes the token once, then the call goes through", async () => {
    const stale = tokens.chat ?? "";
    apps.chat.accepted.delete(stale);
    apps.chat.accepted.add(`${stale}-new`);
    const p = proxy();
    const result = await p.call(chat, "list_chats", {});
    expect(result.isError).toBeUndefined();
    expect(forgotten).toEqual([["chat", stale]]);
    expect(apps.chat.calls.map((c) => c.name)).toEqual(["list_chats"]);
    await p.close();
  });

  test("a second 401 says to sign in again", async () => {
    apps.chat.accepted.clear();
    const p = proxy();
    const result = await p.call(chat, "send_message", { chat_id: 7, text: "hi" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/the chat MCP server did not accept this machine's sign-in: run `tunelo login`/);
    expect(forgotten).toHaveLength(1);
    expect(apps.chat.calls).toEqual([]);
    await p.close();
  });

  test("a missing scope says to sign in again", async () => {
    apps.chat.lacking.add(tokens.chat ?? "");
    const p = proxy();
    const result = await p.call(chat, "send_message", { chat_id: 7, text: "hi" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not allow this chat tool: run `tunelo login`/);
    await p.close();
  });

  test("without a sign-in the call says so and the list fails", async () => {
    signedIn = false;
    const p = proxy();
    const result = await p.call(chat, "list_chats", {});
    expect(text(result)).toMatch(/not signed in/);
    await expect(p.tools(chat)).rejects.toThrow(/not signed in/);
    await p.close();
  });
});
