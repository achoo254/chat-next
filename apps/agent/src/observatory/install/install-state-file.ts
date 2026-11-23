// What `tunelo observatory install` made in a settings.json, kept beside
// Observatory's data (`install-state.json`, 0600): the containers (`hooks`,
// `hooks.<event>`, `env`) that did not exist before, by settings file. The
// uninstall takes out only those when the removal leaves them empty, so a
// container the user had, even empty, stays and the file gets its bytes
// back. No content, no token: member names only.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstallRecord } from "./settings-json-observatory.ts";

type InstallStateFile = { files: Record<string, { created: string[][]; indent: string }> };

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

async function readState(stateFile: string): Promise<InstallStateFile> {
  try {
    const value: unknown = JSON.parse(await readFile(stateFile, "utf8"));
    const files = typeof value === "object" && value !== null ? (value as { files?: unknown }).files : undefined;
    if (typeof files !== "object" || files === null) return { files: {} };
    const out: InstallStateFile = { files: {} };
    for (const [file, entry] of Object.entries(files)) {
      const { created, indent } = typeof entry === "object" && entry !== null ? (entry as { created?: unknown; indent?: unknown }) : {};
      if (Array.isArray(created) && created.every(isStringList) && typeof indent === "string" && /^[ \t]{1,16}$/.test(indent)) out.files[file] = { created, indent };
    }
    return out;
  } catch {
    return { files: {} };
  }
}

async function writeState(stateFile: string, state: InstallStateFile): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, stateFile);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** What the install made in `settingsFile`; undefined when no install of this build recorded it. */
export async function installRecord(stateFile: string, settingsFile: string): Promise<InstallRecord | undefined> {
  return (await readState(stateFile)).files[settingsFile];
}

/** Replaces what is recorded for `settingsFile` with `record` (the install works out what of an earlier record still holds). */
export async function recordInstall(stateFile: string, settingsFile: string, record: InstallRecord): Promise<void> {
  const state = await readState(stateFile);
  state.files[settingsFile] = { created: record.created.map((path) => [...path]), indent: record.indent };
  await writeState(stateFile, state);
}

/** Forgets `settingsFile` (after an uninstall). */
export async function forgetCreated(stateFile: string, settingsFile: string): Promise<void> {
  const state = await readState(stateFile);
  if (!(settingsFile in state.files)) return;
  Reflect.deleteProperty(state.files, settingsFile);
  await writeState(stateFile, state);
}
