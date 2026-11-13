// A folder's project configuration level (ProjectConfigGet/Set): set once
// from a device, logged, kept by the machine per folder (and the folders
// inside it), and applied to every chat session there, new or opened again,
// without the per-session consent. The AI's own CLI in a terminal is never
// restricted: it loads its configuration as in any terminal.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorReason, type Frame, ProjectConfigLevel, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import { projectListBody } from "../src/link/connection.ts";
import { createClaudeProvider, terminalCommand } from "../src/providers/claude/index.ts";
import type { AgentProvider, TerminalLaunch } from "../src/providers/types.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { Transcript } from "./support/claude-transcript.ts";
import { terminalMachine } from "./support/terminal-device.ts";

const none = { sensitive: false, projectSettings: false };
const ALL_SOURCES = ["user", "project", "local"];

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** The Claude adapter on the fake SDK (its options are recorded), with a CLI for the terminal. */
function claude(launches: TerminalLaunch[] = []) {
  const claudeHome = tempDir("claude-home-");
  const sdk = fakeQuery();
  const base = createClaudeProvider({ query: sdk.fn, findBinary: async () => "/bin/claude", homes: () => [claudeHome] });
  const provider: AgentProvider = {
    ...base,
    detect: async () => ({ installed: true, version: "2.1.319", loginState: "ok" }),
    terminal: {
      async command(req) {
        launches.push(req);
        return terminalCommand("/bin/claude", req, randomUUID);
      },
    },
  };
  return { sdk, provider, claudeHome, launches };
}

const turnsDone = (n: number) => (items: Item[]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;
const level = (core: AgentCore, id: string) => core.list().find((s) => s.id === id)?.projectConfig;

async function linked() {
  const c = claude();
  const configDir = join(tempDir("project-config-"), "cfg");
  const m = await terminalMachine({ unit: undefined, configDir, providers: [c.provider] });
  cleanup.push(() => rmSync(dirname(configDir), { recursive: true, force: true }), () => m.terminal.stop(), () => m.core.stop());
  const device = await m.connect(await m.pair("laptop"));
  return { ...m, ...c, device };
}

const bodyOf = (f: Frame) => f.body;

describe("a folder's project configuration over the sealed link", () => {
  it("is off until set, then on for the folder and every folder inside it, logged once with the device and the folder", async () => {
    const m = await linked();
    const inside = join(m.work, "packages", "app");
    mkdirSync(inside, { recursive: true });
    expect(bodyOf(await m.device.request("1", { case: "projectConfigGet", value: { dir: m.work } }))).toEqual({
      case: "projectConfig",
      value: expect.objectContaining({ dir: m.work, level: ProjectConfigLevel.OFF }),
    });
    const set = await m.device.request("2", { case: "projectConfigSet", value: { dir: m.work, level: ProjectConfigLevel.FULL } });
    expect(bodyOf(set)).toEqual({ case: "projectConfig", value: expect.objectContaining({ dir: m.work, level: ProjectConfigLevel.FULL }) });
    const sub = await m.device.request("3", { case: "projectConfigGet", value: { dir: inside } });
    expect(bodyOf(sub)).toMatchObject({ case: "projectConfig", value: { dir: inside, level: ProjectConfigLevel.FULL } });
    // A folder inside may be turned off on its own.
    await m.device.request("4", { case: "projectConfigSet", value: { dir: inside, level: ProjectConfigLevel.OFF } });
    expect(m.core.projectConfig(inside)).toBe(ProjectConfigLevel.OFF);
    expect(m.core.projectConfig(m.work)).toBe(ProjectConfigLevel.FULL);

    const entries = m.audit
      .list()
      .filter((e) => e.action === "project_settings")
      .reverse();
    expect(entries.map((e) => [e.path, e.detail])).toEqual([
      [m.work, "level:full"],
      [inside, "level:off"],
    ]);
    expect(entries.every((e) => e.device.startsWith("laptop"))).toBe(true);
  });

  it("refuses the skills-only level, an unset level, a missing folder and turning on a sensitive folder, changing nothing", async () => {
    const m = await linked();
    const refused = async (id: string, dir: string, lvl: ProjectConfigLevel) => {
      const f = await m.device.request(id, { case: "projectConfigSet", value: { dir, level: lvl } });
      return f.body.case === "error" ? f.body.value.reason : undefined;
    };
    expect(await refused("1", m.work, ProjectConfigLevel.SKILLS)).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    expect(await refused("2", m.work, ProjectConfigLevel.UNSPECIFIED)).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    expect(await refused("3", join(m.work, "gone"), ProjectConfigLevel.FULL)).toBe(ErrorReason.FOLDER_NOT_FOUND);
    expect(await refused("4", "", ProjectConfigLevel.FULL)).toBe(ErrorReason.FOLDER_NOT_FOUND);
    // The home folder is sensitive: trusting it would trust everything under it.
    expect(await refused("5", dirname(m.work), ProjectConfigLevel.FULL)).toBe(ErrorReason.TRUST_ON_MACHINE);
    expect(m.core.projectConfig(m.work)).toBe(ProjectConfigLevel.OFF);
    expect(m.audit.list().filter((e) => e.action === "project_settings")).toEqual([]);
  });

  it("tells the devices the new level of the threads there", async () => {
    const m = await linked();
    const thread = await m.core.create({ provider: "claude", model: "", dir: m.work, text: "hi", consent: none, device: "phone" });
    await until(m.core, thread.id, turnsDone(1));
    expect(level(m.core, thread.id)).toBe(ProjectConfigLevel.OFF);
    await m.device.request("1", { case: "projectConfigSet", value: { dir: m.work, level: ProjectConfigLevel.FULL } });
    const status = await m.device.waitFor((f) => f.body.case === "threadStatus" && f.body.value.thread?.id === thread.id && f.body.value.thread.projectConfig === ProjectConfigLevel.FULL);
    expect(status.body.case).toBe("threadStatus");
  });

  it("the project list carries each project's level", () => {
    const project = { id: "p", name: "w", dir: "/w", pinned: false, defaults: { model: "", permissionMode: "", projectSettings: false }, createdAt: 0, missing: false, sensitive: false };
    const body = projectListBody({ projects: [project], suggestions: [] }, (dir) => (dir === "/w" ? ProjectConfigLevel.FULL : ProjectConfigLevel.OFF));
    expect(body.projects[0]?.projectConfig).toBe(ProjectConfigLevel.FULL);
    expect(projectListBody({ projects: [project], suggestions: [] }).projects[0]).not.toHaveProperty("projectConfig");
  });
});

describe("chat sessions in a folder follow its level", () => {
  function setup(opts: Parameters<typeof makeCore>[1] = {}) {
    const c = claude();
    const m = makeCore([c.provider], opts);
    cleanup.push(() => m.core.stop());
    return { ...c, ...m };
  }

  it("is kept per folder across restarts of the service", async () => {
    const dataDir = join(tempDir("project-config-data-"), "data");
    const first = setup({ dataDir });
    await first.core.setProjectConfig({ dir: first.work, level: ProjectConfigLevel.FULL, device: "phone" });
    await first.core.stop();
    const again = setup({ dataDir, home: first.home });
    expect(again.core.projectConfig(first.work)).toBe(ProjectConfigLevel.FULL);
    expect(again.core.projectConfig(first.home)).toBe(ProjectConfigLevel.OFF);
  });

  it("a new thread in a folder that is on loads the project's configuration without the per-session consent or trust", async () => {
    const { core, sdk, work, audit } = setup();
    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.FULL, device: "phone" });
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    expect(sdk.log.options[0]?.settingSources).toEqual(ALL_SOURCES);
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.FULL);
    // The consent asked for per session is not refused as untrusted there either.
    await core.create({ provider: "claude", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: true }, device: "phone" });
    expect(audit.list().filter((e) => e.action === "project_settings").map((e) => e.detail)).toEqual(["claude", "level:full"]);
  });

  it("a thread opened before it was turned on loads it when its session opens again, resumed; turned off, the next one does not", async () => {
    const { core, sdk, work } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    expect(sdk.log.options[0]?.settingSources).toEqual(["user"]);
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.OFF);

    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.FULL, device: "phone" });
    // The idle session closed, to open again with the folder's configuration.
    expect(core.list().find((s) => s.id === thread.id)).toMatchObject({ open: false, projectConfig: ProjectConfigLevel.FULL });
    await core.send(thread.id, "again", "");
    await until(core, thread.id, turnsDone(2));
    expect(sdk.log.options[1]).toMatchObject({ settingSources: ALL_SOURCES, resume: "claude-session-1" });

    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.OFF, device: "phone" });
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.OFF);
    await core.send(thread.id, "third", "");
    await until(core, thread.id, turnsDone(3));
    expect(sdk.log.options[2]?.settingSources).toEqual(["user"]);
  });

  it("turned on, a closed thread's commands become the folder's at once, without a reload", async () => {
    const { core, provider, work } = setup();
    provider.listCommands = async (req) => (req.projectSettings ? [{ name: "repo-skill", description: "", argumentHint: "", builtin: false }] : [{ name: "user-skill", description: "", argumentHint: "", builtin: false }]);
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    const told: string[] = [];
    cleanup.push(core.onInfo((id) => told.push(id)));
    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.FULL, device: "phone" });
    expect(told).toContain(thread.id);
    const names = () => core.info(thread.id).commands.map((c) => c.name);
    for (let i = 0; i < 50 && !names().includes("repo-skill"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(names()).toContain("repo-skill");
  });

  it("a session of the machine opened from a device (terminal, IDE) loads it too", async () => {
    const { core, sdk, work, claudeHome } = setup();
    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.FULL, device: "phone" });
    const t = new Transcript(randomUUID(), work, "cli").opening();
    t.user("hello");
    t.assistant([{ type: "text", text: "hi" }]);
    // An hour old: not busy elsewhere.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(t.write(claudeHome), hourAgo, hourAgo);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    expect(thread.projectConfig).toBe(ProjectConfigLevel.FULL);
    await core.send(thread.id, "go on", "");
    await until(core, thread.id, (items) => byCase(items, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    expect(sdk.log.options[0]).toMatchObject({ settingSources: ALL_SOURCES, resume: t.sessionId });
  });

  // Turning a folder off is the user's latest word on it, so it also covers
  // the threads opened with the older per-session consent.
  it("a thread opened with the per-session consent loads it until its folder is turned off, then not from its next turn", async () => {
    const { core, sdk, work } = setup({ trusted: () => true });
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: true }, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    expect(sdk.log.options[0]?.settingSources).toEqual(ALL_SOURCES);
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.FULL);

    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.OFF, device: "phone" });
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.OFF);
    await core.send(thread.id, "again", "");
    await until(core, thread.id, turnsDone(2));
    expect(sdk.log.options[1]).toMatchObject({ settingSources: ["user"], resume: "claude-session-1" });
  });

  it("a folder never set leaves the per-session consent as it was", async () => {
    const { core, sdk, work } = setup({ trusted: () => true });
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: true }, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    expect(core.projectConfig(work)).toBe(ProjectConfigLevel.OFF);
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.FULL);
    expect(sdk.log.options[0]?.settingSources).toEqual(ALL_SOURCES);
  });

  it("a session running a turn when its folder changes keeps its level for that turn and switches at the next one", async () => {
    const { core, sdk, work } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "slow", consent: none, device: "phone" });
    await until(core, thread.id, (items) => byCase(items, "turn").some((x) => x.body.value.state === TurnState.RUNNING));
    await core.setProjectConfig({ dir: work, level: ProjectConfigLevel.FULL, device: "phone" });
    // Still the open session's own level while it runs.
    expect(level(core, thread.id)).toBe(ProjectConfigLevel.OFF);
    await core.interrupt(thread.id);
    await until(core, thread.id, turnsDone(1));
    await core.send(thread.id, "next", "");
    await until(core, thread.id, turnsDone(2));
    expect(sdk.log.options.map((o) => o.settingSources)).toEqual([["user"], ALL_SOURCES]);
    expect(sdk.log.options[1]?.resume).toBe("claude-session-1");
  });
});

describe("the AI's own CLI in a terminal", () => {
  it("is never restricted to some setting sources, and keeps the session, model, permission mode and account arguments", () => {
    const id = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
    const resumed = terminalCommand("/bin/claude", { dir: "/w", resumeId: id, accountDir: "/p1", model: "opus", permissionMode: "plan" }, () => "x");
    expect(resumed).toEqual({ file: "/bin/claude", args: ["--resume", id, "--model", "opus", "--permission-mode", "plan"], env: { CLAUDE_CONFIG_DIR: "/p1" } });
    const fresh = terminalCommand("/bin/claude", { dir: "/w" }, () => id);
    expect(fresh.args).toEqual(["--session-id", id]);
    expect([...resumed.args, ...fresh.args].some((a) => a.startsWith("--setting-sources") || a === "--settings")).toBe(false);
  });

  it("opens the same whatever the thread's consent or its folder's level", async () => {
    const launches: TerminalLaunch[] = [];
    const c = claude(launches);
    const m = makeCore([c.provider], { trusted: () => true });
    cleanup.push(() => m.core.stop());
    const plain = await m.core.create({ provider: "claude", model: "", dir: m.work, text: "", consent: none, device: "phone" });
    const consented = await m.core.create({ provider: "claude", model: "", dir: m.work, text: "", consent: { sensitive: false, projectSettings: true }, device: "phone" });
    await m.core.setProjectConfig({ dir: m.work, level: ProjectConfigLevel.FULL, device: "phone" });
    const a = await m.core.terminalLaunch(plain.id);
    const b = await m.core.terminalLaunch(consented.id);
    expect(launches).toEqual([{ dir: m.work }, { dir: m.work }]);
    expect(a.args.filter((x) => x !== a.args[1])).toEqual(["--session-id"]);
    expect(b.args.filter((x) => x !== b.args[1])).toEqual(["--session-id"]);
  });
});
