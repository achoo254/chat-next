// What the Claude sessions tunelo opens get from Observatory
// (providers/types.ts SessionObserver): the OpenTelemetry environment of the
// agent's receiver, the argv of `tunelo observatory hook` for a terminal's
// CLI, a private file for settings holding the receiver's token, and the
// queue of the SDK sessions' hook callbacks (ObservatoryService.takeHookEvent).
//
// It never overrides the user's own telemetry: with any OTel variable in the
// agent's environment, or in the settings.json of the session's Claude folder
// that `tunelo observatory install` did not write, the session gets no OTel
// environment. With Observatory's hooks installed in that settings.json, a
// terminal's CLI gets no second copy of them.
//
// The token never goes on a command line: settings holding it go to a file
// under the Observatory data folder (0600, named by the content's digest so a
// launch with the same settings reuses its file), which the CLI reads with
// `--settings <file>`. Files unused for SETTINGS_FILE_KEEP_MS are deleted.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionObserver } from "../providers/types.ts";
import { hasObservatoryHooks, isOtelKey, observatoryOtelEnv, parseSettings, userOtelKeys } from "./install/observatory-settings-markers.ts";

/** The folder of the CLI settings files, inside the Observatory data folder. */
export const CLAUDE_SETTINGS_DIR = "claude-settings";
/** A settings file not used by a launch for this long is deleted (a session reads its file at start and on a settings reload). */
export const SETTINGS_FILE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionObserverOptions = {
  service: {
    readonly enabled: boolean;
    otlpClient(): { port: number; token: string } | undefined;
    takeHookEvent(event: string, payload: unknown, label?: string): void;
  };
  dataDir: string;
  /** tunelo and the arguments before its own (service.ts selfCommand()). */
  selfCommand: () => string[];
  /** The agent's environment (process.env by default). */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
};

export class ObservatorySessionObserver implements SessionObserver {
  constructor(private readonly opts: SessionObserverOptions) {}

  otelEnv(home: string): Record<string, string> | undefined {
    if (!this.opts.service.enabled) return undefined;
    const client = this.opts.service.otlpClient();
    if (!client || this.userTelemetry(home)) return undefined;
    return observatoryOtelEnv(client);
  }

  hookCommand(home: string): readonly string[] | undefined {
    if (!this.opts.service.enabled) return undefined;
    const settings = this.settingsOf(home);
    if (settings && hasObservatoryHooks(settings)) return undefined;
    return this.opts.selfCommand();
  }

  privateSettingsFile(json: string): string {
    const dir = join(this.opts.dataDir, CLAUDE_SETTINGS_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${createHash("sha256").update(json).digest("hex").slice(0, 32)}.json`);
    const now = (this.opts.now ?? Date.now)();
    this.pruneSettingsFiles(dir, now);
    try {
      if (readFileSync(file, "utf8") === json) {
        utimesSync(file, new Date(now), new Date(now));
        return file;
      }
    } catch {
      // not written yet
    }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, json, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return file;
  }

  hookEvent(event: string, payload: unknown, label?: string): void {
    this.opts.service.takeHookEvent(event, payload, label);
  }

  /** The user's own telemetry: an OTel variable of the agent's environment, or one in the folder's settings Observatory did not write. */
  private userTelemetry(home: string): boolean {
    const env = this.opts.env ?? process.env;
    if (Object.keys(env).some((k) => isOtelKey(k) && env[k] !== undefined)) return true;
    const settings = this.settingsOf(home);
    // Settings that cannot be read: their telemetry is unknown, so none is added.
    return settings === undefined || userOtelKeys(settings).length > 0;
  }

  /** The folder's settings.json ({} when there is none); undefined when it cannot be read as a JSON object. */
  private settingsOf(home: string): Record<string, unknown> | undefined {
    let text: string;
    try {
      text = readFileSync(join(home, "settings.json"), "utf8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
    }
    return parseSettings(text);
  }

  private pruneSettingsFiles(dir: string, now: number): void {
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (now - statSync(path).mtimeMs > SETTINGS_FILE_KEEP_MS) rmSync(path, { force: true });
      }
    } catch {
      // the next launch tries again
    }
  }
}
