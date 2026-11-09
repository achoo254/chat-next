// Consent log on the machine: append-only JSONL of what a device agreed to
// (opening a session in a sensitive folder, loading project settings,
// approving a tool that touches a sensitive path, pairing, revoking,
// switching the permission mode, adding, picking or removing a Claude profile,
// turning forwarding to localhost on or off, blocking ports for it, giving,
// using or removing a sign-in secret: never its value).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type AuditAction =
  | "open_sensitive"
  | "delete_session"
  | "project_add"
  | "project_settings"
  | "approve_sensitive"
  | "pair"
  | "revoke"
  | "permission_mode"
  | "profile_add"
  | "profile_select"
  | "profile_remove"
  | "local_forward"
  | "mcp_local_writes"
  | "secret_add"
  | "secret_use"
  | "secret_remove"
  | "browser_control"
  | "browser_clear";

export type AuditEntry = { at: number; device: string; action: AuditAction; path: string; detail: string };

export class AuditLog {
  constructor(private readonly file: string) {}

  write(entry: Omit<AuditEntry, "at"> & { at?: number }): void {
    const line: AuditEntry = { at: entry.at ?? Date.now(), device: entry.device, action: entry.action, path: entry.path, detail: entry.detail.slice(0, 2000) };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  /** Newest first. */
  list(limit = 100): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    const out: AuditEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // torn line
      }
    }
    return out.reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
  }
}
