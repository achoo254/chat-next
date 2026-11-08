// A stand-in for the `claude` CLI's auth commands, as the profiles code drives
// them: `auth login --claudeai` prints its link inside an OSC 8 hyperlink,
// waits for a code on stdin and, for the good code, "signs in" by writing an
// account file and a credential into CLAUDE_CONFIG_DIR (where the real
// claude keeps its own sign-in); `auth status` reports that account as JSON
// (exit 1 when signed out); `auth logout` removes both files.
// FAKE_CLAUDE_EMAIL / FAKE_CLAUDE_ORG pick the account a sign-in gets;
// FAKE_CLAUDE_SILENT=1 makes login print no link; FAKE_CLAUDE_STATUS_DELAY_MS
// slows `auth status`; FAKE_CLAUDE_LOGOUT_FAIL=1 makes logout fail;
// FAKE_CLAUDE_PID_DIR gets one file per login process, named by its pid.
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOOD_CODE = "GOODCODE-7f3a9c1e5b2d#state-81d2";
export const FAKE_TOKEN = "sk-ant-oat01-FAKE-SECRET-TOKEN-5e1b7a";
export const FAKE_URL_STATE = "state-9c2f6e04aa";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_CONFIG_DIR;
const acct = path.join(dir, "fake-auth.json");
const cred = path.join(dir, ".credentials.json");
const [a, b] = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_PID_DIR && b === "login") fs.writeFileSync(path.join(process.env.FAKE_CLAUDE_PID_DIR, String(process.pid)), "");
const delay = Number(process.env.FAKE_CLAUDE_STATUS_DELAY_MS || 0);
if (a === "auth" && b === "status" && delay > 0) {
  const until = Date.now() + delay;
  while (Date.now() < until) {}
}
if (a === "auth" && b === "status") {
  let s = { loggedIn: false };
  try { s = { loggedIn: true, authMethod: "claude.ai", ...JSON.parse(fs.readFileSync(acct, "utf8")) }; } catch {}
  process.stdout.write(JSON.stringify(s));
  process.exit(s.loggedIn ? 0 : 1);
}
if (a === "auth" && b === "logout" && process.env.FAKE_CLAUDE_LOGOUT_FAIL === "1") {
  process.stderr.write("could not reach the Keychain\\n");
  process.exit(1);
}
if (a === "auth" && b === "logout") {
  fs.rmSync(acct, { force: true });
  fs.rmSync(cred, { force: true });
  console.log("Successfully logged out from your Anthropic account.");
  process.exit(0);
}
if (a === "auth" && b === "login") {
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.FAKE_CLAUDE_SILENT === "1") { setTimeout(() => process.exit(0), 60000); return; }
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=${FAKE_URL_STATE}";
  process.stdout.write("Opening browser to sign in…\\n");
  process.stdout.write("If the browser didn't open, visit: \\u001b]8;;" + url + "\\u001b\\\\" + url + "\\u001b]8;;\\u001b\\\\\\n");
  process.stdout.write("Paste code here if prompted > ");
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c.toString();
    if (!buf.includes("\\n")) return;
    const code = buf.split("\\n")[0];
    if (code !== "${GOOD_CODE}") {
      process.stderr.write("Login failed: That code wasn't accepted.\\n");
      process.exit(1);
    }
    fs.writeFileSync(acct, JSON.stringify({ email: process.env.FAKE_CLAUDE_EMAIL || "second@example.com", orgId: process.env.FAKE_CLAUDE_ORG || "org-1", orgName: "Org One", subscriptionType: "max" }));
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: "${FAKE_TOKEN}" } }));
    console.log("Login successful.");
    process.exit(0);
  });
  return;
}
process.exit(2);
`;

/** Writes the fake CLI to a temp folder; its path stands in for `claude`. */
export function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  return bin;
}

/** Pids of the fake login processes still running, from FAKE_CLAUDE_PID_DIR. */
export function livePids(pidDir: string): number[] {
  return readdirSync(pidDir)
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

/** Signs the machine's own Claude folder in as `email` (the default profile). */
export function signInDefault(claudeHome: string, email: string, orgId = "org-1"): void {
  writeFileSync(join(claudeHome, "fake-auth.json"), JSON.stringify({ email, orgId, orgName: "Org One", subscriptionType: "pro" }));
}
