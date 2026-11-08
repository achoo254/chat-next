// Claude profiles of a fake machine for tests: a Claude folder standing in
// for the machine's own (the default profile, via CLAUDE_CONFIG_DIR), a
// tunelo config folder, the fake claude CLI, a consent log and captured
// service log lines. Callers restore CLAUDE_CONFIG_DIR after each test.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProfiles, type ClaudeProfilesOptions, type RateLimits } from "../../src/profiles/service.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { tempDir } from "../harness.ts";
import { fakeClaude, signInDefault } from "./fake-claude.ts";

export function profilesFixture(
  opts: { ttlMs?: number; urlTimeoutMs?: number; defaultEmail?: string; configDir?: string; probe?: ClaudeProfilesOptions["probeUsage"] } = {},
) {
  const root = tempDir("profiles-signin-");
  const claudeHome = join(root, "claude-home");
  const configDir = opts.configDir ?? join(root, "tunelo");
  const pidDir = join(root, "pids");
  mkdirSync(pidDir, { recursive: true });
  process.env.FAKE_CLAUDE_PID_DIR = pidDir;
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  // The default profile is the machine's Claude folder, as the service sees it.
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  if (opts.defaultEmail) signInDefault(claudeHome, opts.defaultEmail);
  const bin = fakeClaude();
  const audit = new AuditLog(join(configDir, "audit.jsonl"));
  const logs: string[] = [];
  const probed: (string | undefined)[] = [];
  const pushed: [string, RateLimits][] = [];
  const busy = new Set<string>();
  mkdirSync(configDir, { recursive: true });
  const profiles = new ClaudeProfiles({
    configDir,
    audit,
    claudeHome,
    findBinary: async () => bin,
    probeUsage:
      opts.probe ??
      (async (_bin, dir) => {
        probed.push(dir);
        return { fiveHour: { utilization: 12, resetsAt: 1_800_000_000_000 } };
      }),
    inUse: (id) => busy.has(id),
    onUsage: (id, usage) => pushed.push([id, usage]),
    log: (l) => logs.push(l),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    urlTimeoutMs: opts.urlTimeoutMs ?? 5_000,
  });
  return { root, claudeHome, configDir, profiles, audit, logs, probed, pushed, busy, bin, pidDir };
}
