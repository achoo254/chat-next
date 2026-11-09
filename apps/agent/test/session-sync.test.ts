// Claude Code sessions both ways between a device and the machine: a
// session Chat opened is an ordinary Claude Code session on the machine; one
// started in a terminal or an IDE opens from a device with its history; turns
// typed on the machine later show in the thread. Made-up transcripts stand in
// for what claude writes.
import { randomUUID } from "node:crypto";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, ErrorReason, Role, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import { AgentCore, AgentError } from "../src/core/agent-core.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { Transcript, transcriptFile } from "./support/claude-transcript.ts";

const none = { sensitive: false, projectSettings: false };
const HOUR = 3_600_000;

function age(file: string, ago: number): void {
  const t = new Date(Date.now() - ago);
  utimesSync(file, t, t);
}

/** The Claude adapter on the fake SDK, listing the sessions of a made-up Claude folder. */
function claude(sessionId?: string) {
  const claudeHome = tempDir("claude-home-");
  const sdk = fakeQuery(undefined, sessionId ? { sessionId } : {});
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude", homes: () => [claudeHome] });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  return { sdk, provider, claudeHome };
}

const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

function setup(sessionId?: string, opts: Parameters<typeof makeCore>[1] = {}) {
  const c = claude(sessionId);
  const m = makeCore([c.provider], opts);
  cores.push(m.core);
  return { ...c, ...m };
}

const texts = (items: Item[], role: Role) => byCase(items, "text").filter((i) => i.body.value.role === role).map((i) => i.body.value.text);
const turnsDone = (n: number) => (items: Item[]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;

/** A terminal session in `dir`: a question, an answer with a command and its output. */
function terminalSession(dir: string, claudeHome: string, ago = HOUR) {
  const t = new Transcript(randomUUID(), dir, "cli").opening();
  t.user("Chạy test giúp mình");
  t.assistant([
    { type: "text", text: "Mình chạy npm test." },
    { type: "tool_use", id: "toolu_t1", name: "Bash", input: { command: "npm test" } },
  ]);
  t.toolResult("toolu_t1", "12 passed");
  t.assistant([{ type: "text", text: "Tất cả qua." }]);
  t.aiTitle("Chạy test");
  age(t.write(claudeHome), ago);
  return t;
}

describe("a session Chat opened is a Claude Code session of the machine", () => {
  test("it runs claude in the chosen folder on the machine's own Claude folder, is listed as Chat's, and resumes by its id", async () => {
    const id = randomUUID();
    const { core, sdk, claudeHome, work } = setup(id);
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    // The default profile: no CLAUDE_CONFIG_DIR of tunelo's own, so the transcript lands in the machine's
    // ~/.claude/projects, where `claude --resume` in that folder finds it.
    expect(sdk.log.options[0]?.cwd).toBe(work);
    expect(sdk.log.options[0]?.env).toBeUndefined();
    // What claude itself writes for it (the Agent SDK's entrypoint).
    const t = new Transcript(id, work, "sdk-ts").opening();
    t.user("hello");
    t.assistant([{ type: "text", text: "echo: hello" }]);
    t.write(claudeHome);

    const listed = (await core.localSessions({ provider: "claude", dir: "", query: "", offset: 0, limit: 0 })).sessions;
    expect(listed).toHaveLength(1);
    // Written just now, but by this machine's own open session: not "elsewhere".
    expect(listed[0]).toMatchObject({ sessionId: id, dir: work, entrypoint: "sdk-ts", threadId: thread.id, busyElsewhere: false, title: "hello" });

    await core.close(thread.id);
    await core.send(thread.id, "again", "");
    await until(core, thread.id, turnsDone(2));
    expect(sdk.log.options.at(-1)?.resume).toBe(id);
    expect(sdk.log.options.at(-1)?.cwd).toBe(work);
  });
});

describe("opening a session from the machine", () => {
  test("the thread shows its history at once, and the next message resumes that session in its folder", async () => {
    const { core, sdk, claudeHome, work } = setup();
    const t = terminalSession(work, claudeHome);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    expect(thread).toMatchObject({ title: "Chạy test", dir: work, open: false });
    // Nothing runs until the user writes.
    expect(sdk.log.options).toHaveLength(0);
    const items = core.snapshot(thread.id);
    expect(texts(items, Role.USER)).toEqual(["Chạy test giúp mình"]);
    expect(texts(items, Role.ASSISTANT)).toEqual(["Mình chạy npm test.", "Tất cả qua."]);
    expect(byCase(items, "toolCall")[0]?.body.value).toMatchObject({ name: "Bash", summary: "npm test" });
    expect(byCase(items, "toolResult")[0]?.body.value).toMatchObject({ ok: true, output: "12 passed" });
    // Items keep the time they were written on the machine, so they sort before what comes next.
    expect(items[0]?.at).toBe(BigInt(Date.parse("2026-11-01T08:00:02.000Z")));

    await core.send(thread.id, "now lint", "");
    const after = await until(core, thread.id, turnsDone(1));
    expect(sdk.log.options[0]?.resume).toBe(t.sessionId);
    expect(sdk.log.options[0]?.cwd).toBe(work);
    expect(texts(after, Role.ASSISTANT).at(-1)).toBe("echo: now lint");

    // The same session again: the thread that holds it, not a second one.
    const again = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    expect(again.id).toBe(thread.id);
    expect(core.list()).toHaveLength(1);
    const listed = (await core.localSessions({ provider: "claude", dir: "", query: "", offset: 0, limit: 0 })).sessions;
    expect(listed[0]?.threadId).toBe(thread.id);
  });

  test("a session that seems open elsewhere is refused until the user goes on anyway", async () => {
    const { core, claudeHome, work } = setup();
    const t = terminalSession(work, claudeHome, 5_000);
    expect((await core.localSessions({ provider: "claude", dir: "", query: "", offset: 0, limit: 0 })).sessions[0]?.busyElsewhere).toBe(true);
    const err = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).reason).toBe(ErrorReason.SESSION_OPEN_ELSEWHERE);
    expect(core.list()).toHaveLength(0);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: true, device: "phone" });
    expect(core.snapshot(thread.id).length).toBeGreaterThan(0);
  });

  test("the same consent as a new session: a sensitive folder, and project settings in a folder not trusted yet", async () => {
    const trusted: string[] = [];
    const { core, claudeHome, home, work, audit } = setup(undefined, {
      trusted: (d) => trusted.includes(d),
      trust: (d) => void trusted.push(d),
    });
    const inHome = terminalSession(home, claudeHome);
    const sensitive = await core.openLocal({ provider: "claude", sessionId: inHome.sessionId, consent: none, openAnyway: false, device: "phone" }).catch((e: unknown) => e);
    expect([(sensitive as AgentError).code, (sensitive as AgentError).reason]).toEqual([ErrorCode.NEEDS_CONSENT, ErrorReason.SENSITIVE_FOLDER]);
    await core.openLocal({ provider: "claude", sessionId: inHome.sessionId, consent: { sensitive: true, projectSettings: false }, openAnyway: false, device: "phone" });
    expect(audit.list(10).some((e) => e.action === "open_sensitive" && e.path === home)).toBe(true);

    const inWork = terminalSession(work, claudeHome);
    const untrusted = await core
      .openLocal({ provider: "claude", sessionId: inWork.sessionId, consent: { sensitive: false, projectSettings: true }, openAnyway: false, device: "phone" })
      .catch((e: unknown) => e);
    expect((untrusted as AgentError).reason).toBe(ErrorReason.PROJECT_SETTINGS_UNTRUSTED);
    await core.openLocal({ provider: "claude", sessionId: inWork.sessionId, consent: { sensitive: false, projectSettings: true, trustProject: true }, openAnyway: false, device: "phone" });
    expect(trusted).toEqual([work]);
  });

  test("an unknown session, or one whose folder is gone, is refused with its reason", async () => {
    const { core, claudeHome } = setup();
    const missing = await core.openLocal({ provider: "claude", sessionId: randomUUID(), consent: none, openAnyway: false, device: "phone" }).catch((e: unknown) => e);
    expect([(missing as AgentError).code, (missing as AgentError).reason]).toEqual([ErrorCode.NOT_FOUND, ErrorReason.SESSION_NOT_FOUND]);
    const gone = terminalSession("/no/such/folder/anymore", claudeHome);
    const err = await core.openLocal({ provider: "claude", sessionId: gone.sessionId, consent: none, openAnyway: false, device: "phone" }).catch((e: unknown) => e);
    expect((err as AgentError).reason).toBe(ErrorReason.FOLDER_NOT_FOUND);
  });
});

describe("turns typed on the machine later", () => {
  test("show in the thread when a device looks again, once, after what was there; the open session opens again to read them", async () => {
    const { core, sdk, claudeHome, work } = setup();
    const t = terminalSession(work, claudeHome);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    await core.send(thread.id, "from the phone", "");
    await until(core, thread.id, turnsDone(1));
    expect(core.list()[0]?.open).toBe(true);

    // Then, in a terminal on the machine: `claude --resume <id>` and one more turn.
    const before = t.lines.length;
    t.user("from the terminal");
    t.assistant([{ type: "text", text: "answered in the terminal" }]);
    t.appendFrom(claudeHome, before);

    const { items } = core.subscribe(thread.id, undefined);
    expect(texts(items, Role.USER)).toEqual(["Chạy test giúp mình", "from the phone", "from the terminal"]);
    expect(texts(items, Role.ASSISTANT)).toEqual(["Mình chạy npm test.", "Tất cả qua.", "echo: from the phone", "answered in the terminal"]);
    // Looking again adds nothing.
    expect(texts(core.subscribe(thread.id, undefined).items, Role.USER)).toHaveLength(3);

    // The session that was open closes, so the next message resumes it with the terminal's turn in it.
    await until(core, thread.id, () => core.list()[0]?.open === false);
    await core.send(thread.id, "and now?", "");
    await until(core, thread.id, turnsDone(2));
    expect(sdk.log.options.map((o) => o.resume)).toEqual([t.sessionId, t.sessionId]);
  });

  test("also reach a message sent from a device: they come before it", async () => {
    const { core, claudeHome, work } = setup();
    const t = terminalSession(work, claudeHome);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    const before = t.lines.length;
    t.user("typed on the machine");
    t.assistant([{ type: "text", text: "machine reply" }]);
    t.appendFrom(claudeHome, before);
    await core.send(thread.id, "from the phone", "");
    const items = await until(core, thread.id, turnsDone(1));
    expect(texts(items, Role.USER)).toEqual(["Chạy test giúp mình", "typed on the machine", "from the phone"]);
  });

  test("a thread from before this kept no position: what it shows already is not added twice", async () => {
    const id = randomUUID();
    const { core, claudeHome, work, dataDir, home } = setup(id);
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    const live = await until(core, thread.id, turnsDone(1));
    await core.stop();
    cores.splice(cores.indexOf(core), 1);
    // The transcript claude wrote for that turn, with the ids the live stream had, then a terminal turn.
    const reply = byCase(live, "text").find((i) => i.body.value.role === Role.ASSISTANT);
    const [, messageId] = /^text:(.+):0$/.exec(reply?.id ?? "") ?? [];
    const lines = [
      ...new Transcript(id, work, "sdk-ts").opening().user("hello").lines,
      JSON.stringify({ parentUuid: null, isSidechain: false, message: { model: "claude-test", id: messageId, type: "message", role: "assistant", content: [{ type: "text", text: "echo: hello" }] }, apiBlockIndex: 0, type: "assistant", uuid: randomUUID(), timestamp: new Date().toISOString(), cwd: work, sessionId: id }),
      ...new Transcript(id, work, "cli").user("terminal turn").lines,
    ];
    writeFileSync(transcriptFile(claudeHome, work, id), `${lines.join("\n")}\n`);
    // As tunelo 2.0.3 left it: no position in the transcript.
    const metaFile = join(dataDir, "threads", thread.id, "meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    delete meta.history;
    writeFileSync(metaFile, JSON.stringify(meta));

    // The service started again, on the same Claude folder.
    const provider = createClaudeProvider({ query: fakeQuery(undefined, { sessionId: id }).fn, findBinary: async () => "claude", homes: () => [claudeHome] });
    const reopened = new AgentCore({
      dataDir,
      providers: [provider],
      audit: new AuditLog(join(tempDir(), "audit.jsonl")),
      isSensitive: createSensitiveCheck({ home }),
    });
    cores.push(reopened);
    const items = reopened.subscribe(thread.id, undefined).items;
    expect(texts(items, Role.USER)).toEqual(["hello", "terminal turn"]);
    expect(texts(items, Role.ASSISTANT)).toEqual(["echo: hello"]);
  });
});

describe("the session's name", () => {
  test("a session opened without a message waits, runs nothing, and takes its name from the first message", async () => {
    const { core, sdk, work } = setup(randomUUID());
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "", consent: none, device: "phone" });
    expect(thread.title).toBe("");
    expect(sdk.log.options).toHaveLength(0);
    await core.send(thread.id, "Sửa lỗi đăng nhập\nchi tiết ở dưới", "");
    await until(core, thread.id, turnsDone(1));
    expect(core.list().find((s) => s.id === thread.id)?.title).toBe("Sửa lỗi đăng nhập");
  });

  test("follows the name Claude gives the session, and one the user gives it in a terminal, and tells devices", async () => {
    const id = randomUUID();
    const { core, claudeHome, work } = setup(id);
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    const seen: string[] = [];
    core.onStatus((s) => seen.push(s.title));

    const t = new Transcript(id, work, "sdk-ts").opening();
    t.user("hello");
    t.assistant([{ type: "text", text: "echo: hello" }]);
    t.aiTitle("Chào hỏi");
    t.write(claudeHome);
    core.subscribe(thread.id, undefined);
    expect(core.list().find((s) => s.id === thread.id)?.title).toBe("Chào hỏi");
    expect(seen).toContain("Chào hỏi");

    t.customTitle("Phiên của tôi");
    t.write(claudeHome);
    core.subscribe(thread.id, undefined);
    expect(core.list().find((s) => s.id === thread.id)?.title).toBe("Phiên của tôi");
  });
});
