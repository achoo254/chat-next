// Google Antigravity as an AI of tunelo: the user's own `agy` (1.5.2 or
// later) through `agy acp`, on agy's own sign-in. One ACP process serves every
// session (acp-process.ts). Permission modes come from agy (`session/new`);
// agy's own setting `toolPermission: always-proceed` runs every tool without
// asking, so such a machine's sessions run in full access ("full-access", as
// Claude's bypass), which a device may only keep, never pick elsewhere.
// tunelo's own MCP and saved sign-in secrets are not offered to agy yet.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpSession } from "../acp/acp-session.ts";
import type { AgentProvider, Detected, ProviderCapabilities, ProviderSession, SessionPolicy, AskUser, TerminalCommand, TerminalLaunch } from "../types.ts";
import { AgyAcp } from "./acp-process.ts";
import { ANTIGRAVITY_PROVIDER_ID, agyVersion, findAgy, supported, toolPermission } from "./agy.ts";
import { AgyHistory, type ListedSession } from "./history.ts";
import { answerPermission } from "./permissions.ts";
import { describe, toolDiff } from "./tool-map.ts";
import { agyWriter } from "./writer.ts";

const run = promisify(execFile);

/** agy's mode that skips every prompt: its own `toolPermission: always-proceed`. */
export const FULL_ACCESS = "full-access";

/** The modes agy 1.5.8 offers; replaced by what `session/new` says once a session opened. */
const AGY_MODES = ["default", "accept-edits", "auto", "plan"];

type SessionAnswer = {
  sessionId?: string;
  models?: { availableModels?: { modelId?: string; name?: string }[]; currentModelId?: string };
  modes?: { currentModeId?: string; availableModes?: { id?: string }[] };
};

/** Why a session may not open with a mode, given agy's own setting; undefined when it may. */
export function modeRefusal(alwaysProceed: boolean, mode: string | undefined): string | undefined {
  if (alwaysProceed && mode && mode !== FULL_ACCESS) {
    return 'agy on this machine runs every tool without asking (toolPermission "always-proceed" in ~/.gemini/antigravity-cli/settings.json): keep full access, or change that setting in agy to get approvals';
  }
  if (!alwaysProceed && mode === FULL_ACCESS) {
    return 'full access needs agy\'s own setting toolPermission "always-proceed" on this machine';
  }
  return undefined;
}

/** Whether agy's sign-in is on the machine (its Keychain item exists; its value is never read here). */
async function signedIn(): Promise<Detected["loginState"]> {
  if (process.platform !== "darwin") return "unknown";
  try {
    await run("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"], { timeout: 10_000 });
    return "ok";
  } catch (err) {
    return (err as { code?: unknown }).code === 44 ? "needs-login" : "unknown";
  }
}

export function createAntigravityProvider(deps: { findBinary?: () => Promise<string | null>; acp?: AgyAcp; log?: (line: string) => void; toolPermission?: () => string } = {}): AgentProvider {
  const findBinary = deps.findBinary ?? findAgy;
  const log = deps.log ?? (() => undefined);
  const acp = deps.acp ?? new AgyAcp({ findBinary, log });
  const permission = deps.toolPermission ?? (() => toolPermission());
  const capabilities: ProviderCapabilities = {
    interrupt: true,
    resume: true,
    sessionAllow: true,
    questions: false,
    todo: false,
    contextUsage: true,
    compaction: false,
    diff: true,
    images: true,
    models: [],
    effortLevels: [],
    permissionModes: [...AGY_MODES],
    bypassModeId: FULL_ACCESS,
    sessionMcp: false,
  };
  const listSessions = async (): Promise<ListedSession[]> => {
    const live = await acp.get();
    const r = await live.client.request<{ sessions?: { sessionId?: unknown; cwd?: unknown; title?: unknown; updatedAt?: unknown }[] }>("session/list", {}, 30_000);
    return (r.sessions ?? []).flatMap((s) =>
      typeof s.sessionId === "string"
        ? [{ sessionId: s.sessionId, cwd: typeof s.cwd === "string" ? s.cwd : "", title: typeof s.title === "string" ? s.title : "", updatedAt: typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) || 0 : 0 }]
        : [],
    );
  };
  const history = new AgyHistory({ listSessions, log });

  /** What agy said about itself in a session's answer: its models and modes. */
  const learn = (r: SessionAnswer) => {
    const models = (r.models?.availableModels ?? []).flatMap((m) => (m.modelId ? [{ id: m.modelId, name: m.name ?? m.modelId }] : []));
    if (models.length > 0) capabilities.models = models;
    const modes = (r.modes?.availableModes ?? []).flatMap((m) => (m.id ? [m.id] : []));
    if (modes.length > 0) capabilities.permissionModes = modes;
  };

  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    name: "Antigravity",
    capabilities,
    history,
    writer: agyWriter(findBinary),
    terminal: {
      async command(req: TerminalLaunch): Promise<TerminalCommand | undefined> {
        const bin = await findBinary();
        if (!bin) return undefined;
        if (req.resumeId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(req.resumeId)) throw new Error("not a session id of agy");
        return { file: bin, args: req.resumeId ? ["--conversation", req.resumeId] : [], env: {} };
      },
    },

    async detect(): Promise<Detected> {
      const bin = await findBinary();
      if (!bin) return { installed: false, loginState: "unknown" };
      const version = await agyVersion(bin);
      return {
        installed: true,
        ...(version ? { version } : {}),
        loginState: await signedIn(),
        // Older than this adapter speaks: sessions say to update agy.
        ...(version && !supported(version) ? { untestedVersion: true } : {}),
      };
    },

    async start(opts: { policy: SessionPolicy; resumeId?: string; askUser: AskUser }): Promise<ProviderSession> {
      const { policy } = opts;
      const bin = await findBinary();
      if (!bin) throw new Error("agy is not installed");
      const version = await agyVersion(bin);
      if (version && !supported(version)) throw new Error(`agy ${version} is too old: update agy (1.5.2 or later)`);
      const alwaysProceed = permission() === "always-proceed";
      const refused = modeRefusal(alwaysProceed, policy.permissionMode);
      if (refused) throw new Error(refused);
      const live = await acp.get();
      const params = { cwd: policy.dir, mcpServers: [] };
      const r = opts.resumeId
        ? await live.client.request<SessionAnswer>("session/resume", { sessionId: opts.resumeId, ...params }, 120_000)
        : await live.client.request<SessionAnswer>("session/new", params, 120_000);
      const sessionId = r.sessionId ?? opts.resumeId;
      if (!sessionId) throw new Error("agy opened no session");
      learn(r);
      let model = r.models?.currentModelId ?? "";
      const rules = new Set(policy.sessionRules ?? []);
      const mode = alwaysProceed ? FULL_ACCESS : (r.modes?.currentModeId ?? "default");
      // The permission callback runs only once the session exists: it reaches the session through this.
      const ref: { session?: AcpSession } = {};
      const session = new AcpSession({
        router: live.router,
        sessionId,
        describe: (call) => describe(call, policy.dir),
        diff: (call) => toolDiff(call, policy.dir),
        permission: (p, signal) =>
          answerPermission(
            p,
            { dir: policy.dir, askUser: opts.askUser, isSensitive: policy.isSensitive, rules, onRule: () => ref.session?.emit({ type: "session-rules", rules: [...rules] }) },
            signal,
          ),
        model: () => model,
        mode,
        log,
      });
      ref.session = session;
      live.sessions.add(session);
      const s = session;
      try {
        if (policy.model && policy.model !== model) {
          await s.setModel(policy.model);
          model = policy.model;
        }
        if (!alwaysProceed && policy.permissionMode && policy.permissionMode !== mode) await s.setPermissionMode(policy.permissionMode);
      } catch (err) {
        await s.close();
        live.sessions.delete(s);
        throw err;
      }
      return {
        events: s.events,
        send: (text, images) => s.send(text, images),
        interrupt: () => s.interrupt(),
        close: async () => {
          live.sessions.delete(s);
          await s.close();
        },
        setModel: async (m) => {
          await s.setModel(m);
          model = m;
        },
        setPermissionMode: async (m) => {
          const why = modeRefusal(permission() === "always-proceed", m);
          if (why) throw new Error(why);
          if (m !== FULL_ACCESS) await s.setPermissionMode(m);
        },
      };
    },
  };
}
