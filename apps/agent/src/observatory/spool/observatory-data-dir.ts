// The folder of Observatory's machine-local data: the database, state.json,
// the hook spool, the OTLP token. The same folder the store's database path
// names (store/observatory-db-path.ts): TUNELO_HOME when set, else
// %LOCALAPPDATA%\tunelo\observatory on Windows, else beside the config.
import { dirname, join } from "node:path";
import { configDir } from "../../config.ts";
import { OBSERVATORY_DIR, observatoryDbPath } from "../store/observatory-db-path.ts";

/** This process's Observatory data folder (what a hook process uses). */
export function observatoryDataDir(): string {
  return dirname(observatoryDbPath());
}

/**
 * The data folder of an agent whose config is in `agentConfigDir`: the
 * machine's (observatoryDataDir) for the process's own config folder; for
 * any other (an agent started on a config folder of its own, as tests do),
 * an `observatory` folder inside it, so such an agent never shares the
 * machine's database, spool or port settings.
 */
export function observatoryDataDirFor(agentConfigDir: string): string {
  return agentConfigDir === configDir() ? observatoryDataDir() : join(agentConfigDir, OBSERVATORY_DIR);
}
