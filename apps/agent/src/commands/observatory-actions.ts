// What `tunelo observatory status|export|delete|content|rotate-token` do.
// With the agent running on this config folder every command goes through its
// control channel (observatory-control-routes.ts): the agent is the store's
// one writer. With no agent the command works on the files itself
// (observatory-offline.ts). Output is counts, states and paths: never content
// or a token.
import { join, resolve } from "node:path";
import { AuditLog } from "../safety/audit-log.ts";
import { ConfigStore } from "../config.ts";
import { type SettingsTarget, installState, refreshInstalledToken } from "../observatory/install/observatory-install.ts";
import type { ObservatoryStatus } from "../observatory/observatory-status.ts";
import { loadOrCreateTokens, rotateTokens } from "../observatory/receiver/receiver-token.ts";
import { repoKeyOf } from "../usage/repo-key.ts";
import { deleteOffline, exportOffline, setContentOffline } from "./observatory-offline.ts";
import type { Terminal } from "./mcp-local-writes.ts";

export type ObservatoryCliDeps = {
  /** tunelo's config folder. */
  dir: string;
  /** The Observatory data folder (observatory/spool/observatory-data-dir.ts). */
  dataDir: string;
  /** The machine's Claude settings and its profiles (for install state and a new token). */
  settings: SettingsTarget;
  /** Asks the running agent; rejects when none answers. */
  call: (method: string, path: string, input?: unknown) => Promise<unknown>;
  /** Whether an agent answers on this config folder. */
  running: () => Promise<boolean>;
  term: Terminal;
  now: () => number;
};

const when = (at: number | undefined): string => (at === undefined ? "never" : new Date(at).toISOString());

/** Why the receiver is not listening, in a line; undefined when it is. */
function receiverNote(state: string, port: number | undefined): string | undefined {
  switch (state) {
    case "listening":
      return undefined;
    case "port-taken":
      return `port ${String(port)} is taken by another program: Claude Code's logs are not received until it is free (tunelo tries again every 30 s; it never moves to another port)`;
    case "token-unreadable":
      return "the token file cannot be read: `tunelo observatory rotate-token --replace-unreadable` makes a new one";
    case "no-port":
      return "no free port in 47300-47399";
    case "off":
      return undefined;
    default:
      return state;
  }
}

function statusLines(s: ObservatoryStatus): string[] {
  const r = s.receiver;
  const note = receiverNote(r.state, r.port);
  const lines = [
    `Receiver: ${r.state}${r.port !== undefined ? ` on 127.0.0.1:${r.port}` : ""}${note ? ` (${note})` : ""}`,
    `  requests ${r.stats.requests}, records ${r.stats.received}, refused for the token ${r.stats.unauthorized}, other refusals ${r.stats.refused}, too large ${r.stats.tooLarge}, queue full ${r.stats.queueFull}, malformed ${r.stats.malformed}, previous token ${r.stats.previousToken}`,
    `Store: ${s.store}; last write ${when(s.lastDbWriteAt)}; ${s.pendingWrites} writes waiting`,
    `Last event: ${when(s.lastRecordAt)}`,
  ];
  if (s.spool) {
    const p = s.spool;
    lines.push(`Spool: loaded ${p.loaded}, waiting ${p.pendingBytes} bytes, dropped when full ${p.dropped}, malformed ${p.malformed}, refused ${p.rejected}, set aside ${p.quarantined}`);
  }
  if (s.ingest) {
    const i = s.ingest;
    lines.push(
      `Ingest: records ${i.records}, stored ${i.stored}, unknown events ${i.unknownEvents}, unknown fields ${i.unknownFields}, mistyped fields ${i.mistypedFields}, missing keys ${i.missingKeys}, SDK sessions' spool copies skipped ${i.sdkSpoolSkipped}, failed ${i.failed}`,
    );
  }
  const h = s.sdkHooks;
  lines.push(`Sessions tunelo opens: hook events ${h.taken}, dropped when the queue was full ${h.dropped}, failed ${h.failed}`);
  return lines;
}

/** `tunelo observatory status [--json]`. */
export async function observatoryStatusCommand(deps: ObservatoryCliDeps, json: boolean): Promise<number> {
  const running = await deps.running();
  const installed = await installState(deps.settings.claudeHome);
  const status = running ? ((await deps.call("GET", "/observatory/status")) as ObservatoryStatus) : undefined;
  if (json) {
    deps.term.print(JSON.stringify({ running, installed: installed ?? null, status: status ?? null }, null, 2));
    return 0;
  }
  const config = new ConfigStore(deps.dir).get().observatory;
  deps.term.print(`Observatory: ${config?.enabled === false ? "off" : "on"}`);
  deps.term.print(
    `Claude Code outside tunelo: ${installed === undefined ? "unknown (settings.json is not a JSON object)" : installed.hooks ? `installed${installed.otel ? "" : " (hooks only, no OpenTelemetry)"}` : "not installed (`tunelo observatory install`)"}`,
  );
  if (!status) {
    deps.term.print(`tunelo is not running: nothing is received; hooks of installed sessions keep writing the spool. Port ${config?.otlpPort ?? "not picked yet"}.`);
    return 0;
  }
  for (const line of statusLines(status)) deps.term.print(line);
  return 0;
}

/** `tunelo observatory export <file> [--force]`. */
export async function observatoryExportCommand(deps: ObservatoryCliDeps, file: string, overwrite: boolean): Promise<number> {
  const path = resolve(file);
  const out = (await deps.running())
    ? ((await deps.call("POST", "/observatory/export", { file: path, overwrite })) as { rows: number })
    : await exportOffline(deps.dataDir, path, overwrite);
  deps.term.print(`Exported ${out.rows} rows to ${path}.`);
  return 0;
}

/** `tunelo observatory delete [--yes]`: every row and the spool; the settings stay. */
export async function observatoryDeleteCommand(deps: ObservatoryCliDeps, yes: boolean): Promise<number> {
  if (!yes) {
    if (!deps.term.interactive) {
      deps.term.printError("tunelo: deleting Observatory's data needs `--yes` when not run in a terminal.");
      return 1;
    }
    const answer = (await deps.term.ask('Delete everything Observatory stored on this machine (sessions, prompts, tools, totals)? Type "yes": ').catch(() => "")).trim().toLowerCase();
    if (answer !== "yes") {
      deps.term.print("Nothing deleted.");
      return 1;
    }
  }
  if (await deps.running()) await deps.call("POST", "/observatory/delete");
  else {
    await deleteOffline(deps.dataDir);
    new AuditLog(join(deps.dir, "audit.jsonl")).write({ device: "local", action: "observatory_delete", path: "", detail: "" });
  }
  deps.term.print("Observatory's data is deleted; the settings (content off per project) are kept.");
  return 0;
}

/** `tunelo observatory content <folder> <on|off>`: whether a project's prompts and tool content are kept (its key from the folder's repository). */
export async function observatoryContentCommand(deps: ObservatoryCliDeps, folder: string, action: string): Promise<number> {
  const chosen = action.toLowerCase();
  if (chosen !== "on" && chosen !== "off") throw new Error(`unknown action ${action}: use on or off`);
  const projectKey = repoKeyOf(resolve(folder));
  const storeContent = chosen === "on";
  if (await deps.running()) await deps.call("POST", "/observatory/content", { projectKey, storeContent });
  else {
    await setContentOffline({ config: new ConfigStore(deps.dir), dataDir: deps.dataDir, warn: (line) => deps.term.printError(`tunelo: ${line}`), now: deps.now }, projectKey, storeContent);
    new AuditLog(join(deps.dir, "audit.jsonl")).write({ device: "local", action: "observatory_content", path: projectKey, detail: chosen });
  }
  deps.term.print(
    storeContent
      ? `Content of ${projectKey} is kept again from now on (a redacted excerpt of prompts and tool content); what was removed does not come back.`
      : `Content of ${projectKey} is no longer kept, and what was stored or waiting in the spool is removed. Timings, sizes, tool and file names stay.`,
  );
  return 0;
}

/** `tunelo observatory rotate-token [--replace-unreadable]`; the installed settings take the new token. */
export async function observatoryRotateCommand(deps: ObservatoryCliDeps, replaceUnreadable: boolean): Promise<number> {
  if (await deps.running()) await deps.call("POST", "/observatory/rotate-token", { replaceUnreadable });
  else await rotateTokens(deps.dataDir, { replaceUnreadable });
  const port = new ConfigStore(deps.dir).get().observatory?.otlpPort;
  if (port !== undefined) {
    const { current } = await loadOrCreateTokens(deps.dataDir);
    if (await refreshInstalledToken(deps.settings, { port, token: current })) deps.term.print("  The installed Claude Code settings now carry the new token.");
  }
  deps.term.print(
    replaceUnreadable
      ? "A new token is in place. Claude Code sessions started before keep reporting only if they held a readable token."
      : "A new token is in place; sessions started before keep reporting until the next rotation.",
  );
  return 0;
}
