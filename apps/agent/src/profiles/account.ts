// Who a profile is signed in as, from claude's own report
// (`claude auth status`), and signing it out (`claude auth logout`). tunelo
// never opens claude's credential files or the Keychain: the CLI keeps its
// sign-in where it wants (a Keychain item per folder on macOS, a file in the
// profile elsewhere) and `logout` removes it.
import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Variables that sign claude in by themselves, ahead of its config folder: a
 * profile must run with its own sign-in only, or `auth status` and its
 * sessions would show (and use) another account.
 */
const ACCOUNT_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_[A-Z_]*|CLAUDE_CODE_API_KEY[A-Z_]*)$/;

/** The env of a claude process for a profile; the default profile keeps the service's own. */
export function claudeEnv(configDir: string | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (configDir) {
    for (const key of Object.keys(env)) if (ACCOUNT_VARS.test(key)) Reflect.deleteProperty(env, key);
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

type Run = { code: number; stdout: string };

/** Runs a short claude command; its output is never logged. */
export function runClaude(bin: string, args: string[], configDir: string | undefined, timeoutMs = 15_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: claudeEnv(configDir), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

const statusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
});

export type ClaudeAccount = { loggedIn: boolean; email: string; orgId: string; orgName: string; plan: string };

/** The account of a profile; null when claude gave no readable report. */
export async function readAccount(bin: string, configDir: string | undefined): Promise<ClaudeAccount | null> {
  // Exit code 1 means "not signed in"; the JSON report is printed either way.
  const { stdout } = await runClaude(bin, ["auth", "status", "--json"], configDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const r = statusSchema.safeParse(parsed);
  if (!r.success) return null;
  const s = r.data;
  return { loggedIn: s.loggedIn, email: s.email ?? "", orgId: s.orgId ?? "", orgName: s.orgName ?? "", plan: s.subscriptionType ?? "" };
}

/** Same person in the same organization: e-mail without case, organization id as is. */
export function sameAccount(a: Pick<ClaudeAccount, "email" | "orgId">, b: Pick<ClaudeAccount, "email" | "orgId">): boolean {
  return a.email !== "" && a.email.toLowerCase() === b.email.toLowerCase() && a.orgId === b.orgId;
}

/** `claude auth logout` for the profile; true when claude says it worked. */
export async function signOut(bin: string, configDir: string): Promise<boolean> {
  return (await runClaude(bin, ["auth", "logout"], configDir)).code === 0;
}
