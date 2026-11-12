// Real git repositories in the run's temp folder for the workspace tests,
// with git's global config pointed at a file of the test's own (an author,
// branch "main") and the system config off, so the machine's own git setup
// (credential helpers, hooks templates) never takes part.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { errorBody } from "../../src/link/connection.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { Workspaces, type WorkspacesOptions } from "../../src/workspace/workspaces.ts";
import { tempDir } from "../harness.ts";

const globalConfig = join(tempDir("ws-gitconfig-"), "gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A new repository on branch main (in `dir`, else a fresh temp folder). */
export function repo(dir?: string): string {
  const d = dir ?? join(tempDir("ws-repo-"), "work");
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", d], { stdio: "pipe" });
  return d;
}

export function commitAll(dir: string, message = "change"): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", message);
}

/** A local bare repository standing in for a remote (file transport: tests only). */
export const TEST_GIT_CONFIG = ["-c", "protocol.file.allow=always"];

export function workspaces(dirs: Record<string, string>, extra: Partial<WorkspacesOptions> = {}) {
  const root = tempDir("ws-svc-");
  const auditFile = join(root, "audit.jsonl");
  const audit = new AuditLog(auditFile);
  const trashDir = join(root, "trash");
  mkdirSync(trashDir);
  const trashed: string[] = [];
  const ws = new Workspaces({
    folderOf: (id) => dirs[id],
    audit,
    isSensitive: () => false,
    // The operating system's trash stands in as a folder of the test's own.
    trash: async (paths) => {
      for (const p of paths) {
        renameSync(p, join(trashDir, `${trashed.length}-${basename(p)}`));
        trashed.push(p);
      }
    },
    hooksDir: join(root, "empty-hooks"),
    extraGitConfig: TEST_GIT_CONFIG,
    ...extra,
  });
  return { ws, audit, auditFile, trashDir, trashed };
}

/** The reason a device would get for the failure of `p` (throws when it does not fail). */
export async function reasonOf(p: Promise<unknown>): Promise<{ reason: ErrorReason; subject: string; code: number }> {
  try {
    await p;
  } catch (err) {
    const b = errorBody(err);
    return { reason: b.reason, subject: b.subject, code: b.code };
  }
  throw new Error("expected a failure");
}
