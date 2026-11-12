// With the real `claude` on this machine (opt in: TUNELO_REAL_CLAUDE=1; it
// signs in with the machine's own account and spends a few small turns):
// - a chat session loads a folder's project skills, commands and hooks only
//   when the folder's project configuration is on;
// - why there is no "skills and commands only" level: Claude Code takes a
//   project skill's own front matter with it, so a skill loaded on its own
//   (here as a plugin, without the project's settings) still runs its hooks
//   and pre-approves its allowed tools.
// Skipped everywhere else (CI has no signed-in claude).
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeProvider, findClaude } from "../src/providers/claude/index.ts";
import type { AskUser } from "../src/providers/types.ts";
import { tempDir } from "./harness.ts";

const REAL = process.env.TUNELO_REAL_CLAUDE === "1";
const MODEL = "haiku";

const root = REAL ? tempDir("real-claude-project-config-") : "";
const repo = join(root, "repo");
const markers = join(root, "markers");
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A project with a skill, a command, a hook on every session start and prompt, and an allow rule. */
function makeRepo(): void {
  mkdirSync(join(repo, ".claude", "skills", "probe-skill"), { recursive: true });
  mkdirSync(join(repo, ".claude", "skills", "probe-risky"), { recursive: true });
  mkdirSync(join(repo, ".claude", "commands"), { recursive: true });
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "probe-skill", "SKILL.md"), "---\nname: probe-skill\ndescription: Replies PROBE.\n---\nReply with the single word PROBE.\n");
  writeFileSync(
    join(repo, ".claude", "skills", "probe-risky", "SKILL.md"),
    [
      "---",
      "name: probe-risky",
      "description: Runs one touch command.",
      "allowed-tools: Bash(touch skill-allowed-marker)",
      "hooks:",
      "  PreToolUse:",
      '    - matcher: "Bash"',
      "      hooks:",
      "        - type: command",
      `          command: "touch ${join(markers, "skill-hook")}"`,
      "---",
      "Use the Bash tool to run exactly: touch skill-allowed-marker",
      "Then reply done.",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, ".claude", "commands", "probe-cmd.md"), "---\ndescription: Probe command\n---\nReply with PROBECMD.\n");
  const hook = (name: string) => [{ hooks: [{ type: "command", command: `touch ${join(markers, name)}` }] }];
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: hook("session-start"), UserPromptSubmit: hook("prompt") }, permissions: { allow: ["Bash(touch allowed-marker)"] } }),
  );
}

const deny = (async () => ({ decision: "deny" })) as unknown as AskUser;

/** One turn in a chat session of the adapter; what it listed and which project hooks ran. */
async function chatTurn(projectSettings: boolean): Promise<{ commands: string[]; hooks: string[] }> {
  rmSync(markers, { recursive: true, force: true });
  mkdirSync(markers);
  const provider = createClaudeProvider();
  const session = await provider.start({
    policy: { dir: repo, mcpServers: {}, projectSettings, isSensitive: () => false, model: MODEL, permissionMode: "default" },
    askUser: deny,
  });
  const commands = new Set<string>();
  await session.send("Reply with the single word OK.");
  for await (const e of session.events) {
    if (e.type === "info") for (const c of e.commands ?? []) commands.add(c.name);
    if (e.type === "turn-end") break;
  }
  await session.close();
  return { commands: [...commands].filter((c) => c.startsWith("probe")).sort(), hooks: ["session-start", "prompt"].filter((m) => existsSync(join(markers, m))) };
}

describe.runIf(REAL)("project configuration with the real claude", () => {
  beforeAll(makeRepo);

  it("off: no project skill, command or hook", async () => {
    expect(await chatTurn(false)).toEqual({ commands: [], hooks: [] });
  }, 120_000);

  it("on: the project's skills, commands and hooks, as in a terminal", async () => {
    expect(await chatTurn(true)).toEqual({ commands: ["probe-cmd", "probe-risky", "probe-skill"], hooks: ["session-start", "prompt"] });
  }, 120_000);

  it("skills alone (as a plugin, no project settings): the settings' hooks stay off, but a skill's own hooks and allowed tools act", async () => {
    rmSync(markers, { recursive: true, force: true });
    mkdirSync(markers);
    rmSync(join(repo, "skill-allowed-marker"), { force: true });
    const plugin = join(root, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "project" }));
    symlinkSync(join(repo, ".claude", "skills"), join(plugin, "skills"));
    const bin = await findClaude();
    if (!bin) throw new Error("claude is not installed");
    const asked: string[] = [];
    const q = query({
      prompt: "/project:probe-risky",
      options: {
        pathToClaudeCodeExecutable: bin,
        cwd: repo,
        settingSources: ["user"],
        plugins: [{ type: "local", path: plugin, skipMcpDiscovery: true }],
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: "default",
        model: MODEL,
        maxTurns: 3,
        canUseTool: async (name) => {
          asked.push(name);
          return { behavior: "deny", message: "denied" };
        },
      },
    });
    for await (const m of q) if (m.type === "result") break;
    // The project's settings did not load: their hooks never ran...
    expect(existsSync(join(markers, "session-start"))).toBe(false);
    // ...but the skill's own hook ran, and its allowed tool ran without asking.
    expect(existsSync(join(markers, "skill-hook"))).toBe(true);
    expect(existsSync(join(repo, "skill-allowed-marker"))).toBe(true);
    expect(asked).toEqual([]);
  }, 120_000);
});
