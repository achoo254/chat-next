// Claude Code sessions kept on the machine, read from made-up transcripts in
// the shape claude writes them: what a list shows, how little it reads, and
// what a session gives when it is read back.
import { appendFileSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { LocalSessions, RECENT_BYTES } from "../src/providers/claude/local-sessions.ts";
import { cleanPrompt } from "../src/providers/claude/transcript.ts";
import { tempDir } from "./harness.ts";
import { Transcript } from "./support/claude-transcript.ts";

const NOW = Date.parse("2026-11-09T05:00:00.000Z");
const HOUR = 3_600_000;

/** Sets a file's change time `ago` ms before NOW. */
function age(file: string, ago: number): void {
  const t = new Date(NOW - ago);
  utimesSync(file, t, t);
}

function sessions(homes: string[], alive: (pid: number) => boolean = () => false) {
  return new LocalSessions({ homes: () => homes, now: () => NOW, alive });
}

const all = { dir: "", query: "", offset: 0, limit: 0 };

describe("listing", () => {
  test("each session: id, the folder its transcript records, a title, when it changed, messages, what started it", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/Users/me/work/shop", "cli").opening();
    t.meta("Base directory for this skill: /Users/me/.claude/skills/x");
    t.user("<command-message>init</command-message>\n<command-name>/init</command-name>\n<command-args>quickly</command-args>");
    t.user("Thêm nút thanh toán vào trang giỏ hàng");
    t.assistant([{ type: "thinking", thinking: "…" }, { type: "text", text: "Đã thêm nút." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }]);
    t.toolResult("toolu_1", "ok");
    const file = t.write(home);
    age(file, 2 * HOUR);

    const page = sessions([home]).list(all);
    expect(page.total).toBe(1);
    const s = page.sessions[0];
    expect(s).toMatchObject({ sessionId: id, dir: "/Users/me/work/shop", entrypoint: "cli", busy: false });
    // The first thing typed: the slash command as the terminal shows it, not the skill's text claude added.
    expect(s?.title).toBe("/init quickly");
    // Two typed messages and one text reply; the note, the thinking, the tool call and its result are not messages.
    expect(s?.messages).toBe(3);
    expect(s?.updatedAt).toBe(NOW - 2 * HOUR);
  });

  test("the folder is the one recorded in the transcript, not guessed from the folder name", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    // A folder with a dash reads back the same as one with a slash: only the record tells them apart.
    const t = new Transcript(id, "/Users/me/my-app").opening();
    t.user("hello");
    t.write(home);
    expect(sessions([home]).list(all).sessions[0]?.dir).toBe("/Users/me/my-app");
  });

  test("a title the user gave wins over Claude's, which wins over the first message; one line, at most 120 characters", () => {
    const home = tempDir("claude-home-");
    const a = new Transcript(randomUUID(), "/w/a").opening();
    a.user("first question\nwith a second line");
    a.write(home);
    const b = new Transcript(randomUUID(), "/w/b").opening();
    b.user("anything");
    b.aiTitle("Claude's name for it");
    b.write(home);
    const c = new Transcript(randomUUID(), "/w/c").opening();
    c.user("anything");
    c.aiTitle("Claude's name");
    c.customTitle("Mine");
    c.aiTitle("Claude's later name");
    c.write(home);
    const d = new Transcript(randomUUID(), "/w/d").opening();
    d.user("x ".repeat(200));
    d.write(home);

    const byDir = new Map(sessions([home]).list(all).sessions.map((s) => [s.dir, s.title]));
    expect(byDir.get("/w/a")).toBe("first question with a second line");
    expect(byDir.get("/w/b")).toBe("Claude's name for it");
    expect(byDir.get("/w/c")).toBe("Mine");
    expect(byDir.get("/w/d")?.length).toBe(120);
    expect(byDir.get("/w/d")?.endsWith("…")).toBe(true);
  });

  test("newest first, a page at a time, filtered by folder (and below) and by words", () => {
    const home = tempDir("claude-home-");
    const dirs = ["/w/shop", "/w/shop/api", "/w/blog"];
    const files: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = new Transcript(randomUUID(), dirs[i % 3] ?? "/w").opening();
      t.user(i === 4 ? "Sửa lỗi đăng nhập Google" : `task ${i}`);
      files.push(t.write(home));
      age(files[i] ?? "", (10 - i) * HOUR);
    }
    const list = sessions([home]);
    const first = list.list({ ...all, limit: 4 });
    expect(first.total).toBe(6);
    expect(first.sessions.map((s) => s.title)).toEqual(["task 5", "Sửa lỗi đăng nhập Google", "task 3", "task 2"]);
    expect(list.list({ ...all, limit: 4, offset: 4 }).sessions.map((s) => s.title)).toEqual(["task 1", "task 0"]);
    // Every folder with how many sessions, whatever the folder filter.
    expect(first.dirs).toEqual([
      { dir: "/w/blog", sessions: 2 },
      { dir: "/w/shop", sessions: 2 },
      { dir: "/w/shop/api", sessions: 2 },
    ]);
    expect(list.list({ ...all, dir: "/w/shop" }).total).toBe(4);
    expect(list.list({ ...all, dir: "/w/shop/api" }).total).toBe(2);
    // Every word, any case, in the title or the folder.
    expect(list.list({ ...all, query: "google ĐĂNG" }).sessions.map((s) => s.title)).toEqual(["Sửa lỗi đăng nhập Google"]);
    expect(list.list({ ...all, query: "blog" }).total).toBe(2);
    expect(list.list({ ...all, query: "nothing-like-this" }).total).toBe(0);
  });

  test("only session transcripts are listed: no subagent files, no empty sessions", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user("real one");
    const file = t.write(home);
    // A subagent's transcript next to it, and an older agent-<id>.jsonl.
    mkdirSync(join(file.slice(0, -".jsonl".length), "subagents"), { recursive: true });
    writeFileSync(join(file.slice(0, -".jsonl".length), "subagents", `${randomUUID()}.jsonl`), t.lines.join("\n"));
    writeFileSync(join(file, "..", "agent-1234.jsonl"), t.lines.join("\n"));
    // Started, then nothing was asked.
    new Transcript(randomUUID(), "/w/y").opening().write(home);
    expect(sessions([home]).list(all).sessions.map((s) => s.sessionId)).toEqual([id]);
  });

  test("a profile's projects folder linked to the machine's lists each session once", () => {
    const home = tempDir("claude-home-");
    const t = new Transcript(randomUUID(), "/w/x").opening();
    t.user("one");
    t.write(home);
    const profile = tempDir("claude-profile-");
    symlinkSync(join(home, "projects"), join(profile, "projects"));
    expect(sessions([home, profile]).list(all).total).toBe(1);
  });
});

describe("open elsewhere", () => {
  test("a transcript changed in the last minute seems open elsewhere", () => {
    const home = tempDir("claude-home-");
    const t = new Transcript(randomUUID(), "/w/x").opening();
    t.user("one");
    const file = t.write(home);
    age(file, 10_000);
    expect(sessions([home]).list(all).sessions[0]?.busy).toBe(true);
    age(file, 5 * 60_000);
    expect(sessions([home]).list(all).sessions[0]?.busy).toBe(false);
  });

  test("so does one a running claude registered, in any Claude folder; a dead one's record does not count", () => {
    const home = tempDir("claude-home-");
    const profile = tempDir("claude-profile-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user("one");
    age(t.write(home), HOUR);
    mkdirSync(join(profile, "sessions"));
    writeFileSync(join(profile, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: id, cwd: "/w/x", kind: "interactive", entrypoint: "cli" }));
    // Never read: only <pid>.json records are.
    writeFileSync(join(profile, "sessions", "4242.abc.key"), "secret");
    expect(sessions([home, profile], (pid) => pid === 4242).list(all).sessions[0]?.busy).toBe(true);
    expect(sessions([home, profile], () => false).list(all).sessions[0]?.busy).toBe(false);
  });
});

describe("the session a claude started in a terminal holds now", () => {
  const STARTED = NOW - HOUR;
  function registers() {
    const home = tempDir("claude-home-");
    const profile = tempDir("claude-profile-");
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(profile, "sessions"));
    const register = (dir: string, pid: number, body: Record<string, unknown> | string) =>
      writeFileSync(join(dir, "sessions", `${pid}.json`), typeof body === "string" ? body : JSON.stringify({ pid, kind: "interactive", ...body }));
    return { home, profile, register };
  }

  test("the running claude working in the folder that started with the terminal's CLI, in any Claude folder: the session it went on in (/resume, /clear)", () => {
    const { home, profile, register } = registers();
    const launched = randomUUID();
    const now = randomUUID();
    register(profile, 4242, { sessionId: now.toUpperCase(), cwd: "/w/x", startedAt: STARTED + 1_500 });
    // Another claude in another folder, or started long before in the same one, is not the terminal's.
    register(home, 5151, { sessionId: randomUUID(), cwd: "/w/y", startedAt: STARTED });
    register(home, 6161, { sessionId: randomUUID(), cwd: "/w/x", startedAt: STARTED - HOUR });
    // Garbage and records with no start or folder count for nothing.
    register(home, 7171, "{being writ");
    register(home, 8181, { sessionId: randomUUID() });
    const s = sessions([home, profile], () => true);
    expect(s.terminalHeldSession({ dir: "/w/x", startedAt: STARTED, sessionId: launched })).toBe(now);
    expect(s.terminalHeldSession({ dir: "/w/x/", startedAt: STARTED })).toBe(now);
    // Nothing matches: a start too far off, another folder.
    expect(s.terminalHeldSession({ dir: "/w/x", startedAt: STARTED + 30_000 })).toBeUndefined();
    expect(s.terminalHeldSession({ dir: "/w/z", startedAt: STARTED })).toBeUndefined();
    // A process that still holds the thread's session matches without its start.
    expect(s.terminalHeldSession({ dir: "/w/z", startedAt: 0, sessionId: now })).toBe(now);
  });

  test("two claudes that could be the terminal's, or one that no longer runs: nothing", () => {
    const { home, register } = registers();
    const held = randomUUID();
    register(home, 4242, { sessionId: randomUUID(), cwd: "/w/x", startedAt: STARTED + 2_000 });
    register(home, 4343, { sessionId: randomUUID(), cwd: "/w/x", startedAt: STARTED - 3_000 });
    expect(sessions([home], () => true).terminalHeldSession({ dir: "/w/x", startedAt: STARTED })).toBeUndefined();
    // One started in the window, another still holding the thread's session: two processes, nothing.
    register(home, 4343, { sessionId: held, cwd: "/w/y", startedAt: STARTED - HOUR });
    expect(sessions([home], () => true).terminalHeldSession({ dir: "/w/x", startedAt: STARTED, sessionId: held })).toBeUndefined();
    // The terminal's claude ended (its record left behind): nothing.
    expect(sessions([home], (pid) => pid !== 4242).terminalHeldSession({ dir: "/w/x", startedAt: STARTED })).toBeUndefined();
  });
});

describe("reading little", () => {
  test("a large transcript: the start and the end give the folder and the title; the count covers the whole file once, then only what was added", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/big").opening();
    t.user("start here");
    for (let i = 0; i < 40; i++) {
      t.blob(100_000);
      const tool = `toolu_${i}`;
      t.assistant([{ type: "text", text: `step ${i}` }, { type: "tool_use", id: tool, name: "Read", input: { file_path: "/w/big/a.ts" } }]);
      t.toolResult(tool, "y".repeat(50_000));
    }
    t.aiTitle("Big refactor");
    const file = t.write(home);
    age(file, HOUR);
    const list = sessions([home]);
    const s = list.list(all).sessions[0];
    expect(s).toMatchObject({ dir: "/w/big", title: "Big refactor", messages: 41 });

    // A later turn from a terminal: counted from where the count stopped.
    const before = t.lines.length;
    t.user("one more");
    t.assistant([{ type: "text", text: "done" }]);
    t.aiTitle("Bigger refactor");
    t.appendFrom(home, before);
    age(file, HOUR);
    expect(list.list(all).sessions[0]).toMatchObject({ title: "Bigger refactor", messages: 43 });
  });

  test("a line too long to keep is skipped, not mistaken for the next one", () => {
    const home = tempDir("claude-home-");
    const t = new Transcript(randomUUID(), "/w/x").opening();
    t.user("first");
    t.assistant([{ type: "text", text: "reply" }]);
    const file = t.write(home);
    // A huge record, then a user message after it.
    appendFileSync(file, `${JSON.stringify({ type: "api-request-blob", message: { role: "user", content: "z".repeat(3 * 1024 * 1024) } })}\n`);
    const after = new Transcript(t.sessionId, "/w/x");
    after.user("second");
    appendFileSync(file, `${after.lines.join("\n")}\n`);
    age(file, HOUR);
    expect(sessions([home]).list(all).sessions[0]?.messages).toBe(3);
  });
});

describe("reading a session back", () => {
  test("user messages, replies, tool calls with their results, and the diff of an edit, with the ids a live session gives them", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/shop").opening();
    t.user("Đổi tiêu đề trang chủ");
    const msg = t.assistant([
      { type: "text", text: "Mình sửa file." },
      { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "/w/shop/index.html", old_string: "<h1>Cũ</h1>", new_string: "<h1>Mới</h1>" } },
    ]);
    t.toolResult("toolu_edit", "The file was updated.");
    t.user([{ type: "text", text: "Xem ảnh này" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
    t.user("<local-command-stdout>Total cost: $0.00</local-command-stdout>");
    t.write(home);

    const read = sessions([home]).read(id, 0);
    expect(read?.entries.map((e) => e.type)).toEqual(["user", "text", "tool-start", "diff", "tool-end", "user"]);
    const [first, reply, call, diff, result, image] = read?.entries ?? [];
    expect(first).toMatchObject({ type: "user", text: "Đổi tiêu đề trang chủ" });
    expect(first?.at).toBe(Date.parse("2026-11-01T08:00:02.000Z"));
    // As the live stream names a block: message id and block index.
    expect(reply).toMatchObject({ type: "text", blockId: `${msg}:0`, role: "assistant", text: "Mình sửa file." });
    expect(call).toMatchObject({ type: "tool-start", toolId: "toolu_edit", kind: "edit", summary: "index.html" });
    expect(diff).toMatchObject({ type: "diff", path: "index.html", added: 1, removed: 1 });
    expect(result).toMatchObject({ type: "tool-end", toolId: "toolu_edit", ok: true, output: "The file was updated." });
    expect(image).toMatchObject({ type: "user", text: "Xem ảnh này\n[image]" });
  });

  test("reading on from a position gives only what was appended after it", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user("one");
    t.assistant([{ type: "text", text: "1" }]);
    t.write(home);
    const list = sessions([home]);
    const end = list.end(id) ?? 0;
    const before = t.lines.length;
    t.user("two");
    t.assistant([{ type: "text", text: "2" }]);
    t.appendFrom(home, before);
    const read = list.read(id, end);
    expect(read?.entries.map((e) => (e.type === "user" || e.type === "text" ? e.text : e.type))).toEqual(["two", "2"]);
    expect(read?.end).toBe(list.end(id));
  });

  test("the newest part of a long session starts at a user message", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    for (let i = 0; i < 12; i++) {
      t.user(`question ${i}`);
      t.assistant([{ type: "text", text: `answer ${i} ${"w".repeat(1024 * 1024)}` }]);
    }
    t.write(home);
    const read = sessions([home]).read(id, "recent");
    const entries = read?.entries ?? [];
    expect(entries[0]?.type).toBe("user");
    expect(entries.length).toBeLessThan(24);
    expect(entries.at(-1)).toMatchObject({ type: "text" });
    // Each answer is about 1 MB: no more of them than fit in the newest part read.
    expect(entries.filter((e) => e.type === "text").length).toBeLessThanOrEqual(RECENT_BYTES / (1024 * 1024));
  });

  test("an id that is not one of claude's is never looked for", () => {
    expect(sessions(["/nowhere"]).end("claude-session-1")).toBeUndefined();
    expect(sessions(["/nowhere"]).find(randomUUID())).toBeUndefined();
  });
});

describe("background shells and subagents", () => {
  // The structured result claude writes with a launch (what it records, beside the text the model reads).
  const launchAgent = (t: Transcript, id: string) =>
    t.user([{ tool_use_id: "toolu_a", type: "tool_result", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id} (internal ID)` }] }], {
      toolUseResult: { isAsync: true, status: "async_launched", agentId: id, description: "review", prompt: "a long prompt" },
    });
  const launchShell = (t: Transcript, id: string) =>
    t.user([{ tool_use_id: "toolu_s", type: "tool_result", content: `Command did not complete within its 600s timeout and was moved to the background (ID: ${id}).` }], {
      toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: id },
    });
  const notice = (id: string, status = "completed") => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`;
  /** The notification as a message between turns. */
  const finished = (t: Transcript, id: string, status = "completed") => t.user(notice(id, status), { origin: { kind: "task-notification" } });

  test("a launch counts until its task-notification, whatever the task's end (finished, failed, stopped)", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user("deploy it");
    launchShell(t, "b1x9");
    launchAgent(t, "a77e01");
    t.write(home);
    const s = sessions([home]);
    expect(s.backgroundTasks(id)).toBe(2);
    // The shell's end and the subagent's stop each take their own task off; a status that is only progress keeps it.
    finished(t, "b1x9");
    finished(t, "a77e01", "running");
    t.write(home);
    expect(s.backgroundTasks(id)).toBe(1);
    finished(t, "a77e01", "killed");
    t.write(home);
    expect(s.backgroundTasks(id)).toBe(0);
  });

  test("a notification that arrived during a turn is a queued command and an attachment, and ends the task as well", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    launchShell(t, "b1x9");
    launchShell(t, "b2y8");
    const file = t.write(home);
    const s = sessions([home]);
    expect(s.backgroundTasks(id)).toBe(2);
    appendFileSync(file, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: id, content: JSON.stringify(notice("b1x9")) })}\n`);
    expect(s.backgroundTasks(id)).toBe(1);
    appendFileSync(file, `${JSON.stringify({ parentUuid: null, isSidechain: false, attachment: { type: "queued_command", prompt: notice("b2y8", "failed") }, type: "attachment", uuid: randomUUID() })}\n`);
    expect(s.backgroundTasks(id)).toBe(0);
  });

  test("reads only what was appended, and starts over when the transcript was replaced by a shorter one", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    launchShell(t, "b1x9");
    const file = t.write(home);
    const s = sessions([home]);
    expect(s.backgroundTasks(id)).toBe(1);
    appendFileSync(file, "garbage that is not a record\n");
    expect(s.backgroundTasks(id)).toBe(1);
    const fresh = new Transcript(id, "/w/x");
    fresh.user("hi");
    fresh.write(home);
    expect(s.backgroundTasks(id)).toBe(0);
  });

  test("text that only looks like a launch is none: a tool printing it, the AI's words, a subagent's own records, a notification without a task", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user("show me the diff");
    // A diff or a grep of this very feature prints the words a launch result has.
    t.toolResult("toolu_d", "+ Command did not complete within its 600s timeout and was moved to the background (ID: printed1)\n+ Async agent launched successfully.\n+ agentId: printed2");
    t.assistant([{ type: "text", text: "A shell was moved to the background (ID: said1)" }]);
    const file = t.write(home);
    appendFileSync(file, `${JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [] }, toolUseResult: { backgroundTaskId: "side1" } })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } })}\n`);
    expect(sessions([home]).backgroundTasks(id)).toBe(0);
    // A real launch beside them still counts, and the notification without a task takes nothing off.
    launchShell(t, "real1");
    t.write(home);
    expect(sessions([home]).backgroundTasks(id)).toBe(1);
  });

  test("a long tool output after the launch's markers does not hide it, and one too long to keep whole is not a launch", () => {
    const home = tempDir("claude-home-");
    const id = randomUUID();
    const t = new Transcript(id, "/w/x").opening();
    t.user([{ tool_use_id: "toolu_s", type: "tool_result", content: "started" }], { toolUseResult: { stdout: "y".repeat(100 * 1024), backgroundTaskId: "big1" } });
    t.write(home);
    expect(sessions([home]).backgroundTasks(id)).toBe(1);
    const huge = new Transcript(randomUUID(), "/w/x").opening();
    huge.user([{ tool_use_id: "toolu_s", type: "tool_result", content: "started" }], { toolUseResult: { stdout: "y".repeat(1024 * 1024), backgroundTaskId: "huge1" } });
    huge.write(home);
    expect(sessions([home]).backgroundTasks(huge.sessionId)).toBe(0);
  });
});

test("what the user typed, as the terminal shows it", () => {
  expect(cleanPrompt("<command-name>/review</command-name><command-args></command-args>")).toBe("/review");
  expect(cleanPrompt("<bash-input>git status</bash-input>")).toBe("! git status");
  expect(cleanPrompt("<bash-stdout>clean</bash-stdout>")).toBeUndefined();
  expect(cleanPrompt("<system-reminder>x</system-reminder>")).toBeUndefined();
  expect(cleanPrompt("  plain  ")).toBe("plain");
});
