// `tunelo observatory …` while no agent runs on this config folder: the
// command opens the Observatory database itself (only then: with an agent
// running it always goes through the control channel, the agent being the
// one writer). Switching content off copies the setting into the config,
// state.json and the store, clears the project's stored content, and takes in
// the spool's settled files the way the agent would (its content blocked by
// the store), so nothing of the project's content waits on disk but the
// minute still being written.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigStore } from "../config.ts";
import { AgentStoreHost } from "../observatory/agent-store-host.ts";
import { contentOffOf, setContentOff } from "../observatory/content-settings-config.ts";
import { ObservatoryIngest } from "../observatory/ingest/observatory-ingest.ts";
import { redactRecordAgain } from "../observatory/privacy/redact-record-again.ts";
import { OTLP_TOKEN_FILE, type ReceiverTokens, loadOrCreateTokens } from "../observatory/receiver/receiver-token.ts";
import { deleteTargetKeySalt } from "../observatory/privacy/target-key-salt.ts";
import { clearSpool } from "../observatory/spool/clear-spool.ts";
import { writeHookState } from "../observatory/spool/hook-state-file.ts";
import { SpoolReader } from "../observatory/spool/spool-reader.ts";
import { OBSERVATORY_DB_FILE } from "../observatory/store/observatory-db-path.ts";
import { ObservatoryStore } from "../observatory/store/observatory-store.ts";

export type OfflineContext = {
  config: ConfigStore;
  dataDir: string;
  /** Problems on the way (a line for the user; never content). */
  warn: (line: string) => void;
  now?: () => number;
};

const dbPath = (dataDir: string): string => join(dataDir, OBSERVATORY_DB_FILE);

async function withStore<T>(dataDir: string, use: (store: ObservatoryStore) => Promise<T>): Promise<T> {
  const store = await ObservatoryStore.open({ path: dbPath(dataDir) });
  try {
    return await use(store);
  } finally {
    store.close();
  }
}

/** Writes the export of the database to `file`. */
export function exportOffline(dataDir: string, file: string, overwrite: boolean): Promise<{ rows: number }> {
  return withStore(dataDir, (store) => store.exportToFile(file, { overwrite }));
}

/** Deletes every row and the spool, keeping the settings (content_settings are copied back from the config at the agent's next start). */
export async function deleteOffline(dataDir: string): Promise<void> {
  await withStore(dataDir, (store) => store.wipe());
  await clearSpool(dataDir);
  // The keys stored under it went with the database; the agent makes a new one at its start.
  await deleteTargetKeySalt(dataDir);
}

/** The secret values the agent would hide: the machine's and the receiver's tokens. */
async function knownSecrets(ctx: OfflineContext): Promise<string[]> {
  // Read only: a command never makes the receiver's token file (the agent does, at its start).
  const tokens: ReceiverTokens | undefined = existsSync(join(ctx.dataDir, OTLP_TOKEN_FILE)) ? await loadOrCreateTokens(ctx.dataDir, []).catch(() => undefined) : undefined;
  return [ctx.config.get().machineSecret ?? "", tokens?.current ?? "", tokens?.previous ?? ""].filter((s) => s.length > 0);
}

/** Switches a project's content on or off without the agent (see the module comment). */
export async function setContentOffline(ctx: OfflineContext, projectKey: string, storeContent: boolean): Promise<void> {
  const now = ctx.now ?? Date.now;
  setContentOff(ctx.config, projectKey, storeContent);
  await writeHookState(ctx.dataDir, { enabled: ctx.config.get().observatory?.enabled !== false, contentOff: contentOffOf(ctx.config) });
  const problems = (place: string, err: unknown): void => ctx.warn(`${place}: ${err instanceof Error ? err.message : String(err)}`);
  // Opening copies the config's projects without content into the store and clears what they hold (agent-store-host.ts).
  const host = new AgentStoreHost({ config: ctx.config, dataDir: ctx.dataDir, problems, now });
  await host.open();
  try {
    if (!host.writer) {
      ctx.warn("the Observatory database could not be opened now; the agent clears the content at its next start");
      return;
    }
    host.writer.push({ kind: "contentSetting", row: { projectKey, storeContent, updatedAt: now() } });
    host.commit();
    if (storeContent) return;
    const secrets = await knownSecrets(ctx);
    const ingest = new ObservatoryIngest({ push: (op) => host.writer?.push(op), home: homedir(), log: () => undefined });
    const reader = new SpoolReader({
      dataDir: ctx.dataDir,
      secondPass: (record) => redactRecordAgain(record, secrets),
      accept: (record) => ingest.accept(record, "spool"),
      commit: async () => host.commit(),
      problems,
      now,
    });
    await reader.drainOnce();
  } finally {
    host.close();
  }
}
