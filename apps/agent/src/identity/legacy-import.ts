/**
 * One-time move of sign-ins and settings written by older installs into
 * tunelo's sealed session (session.ts) and settings (cli-settings.ts):
 *
 * - `<config dir>/tunelo-session.json`: the plain session of tunelo 2.0 and
 *   hda, taken first (the machine was registered with it).
 * - `~/.tunelo/config.json`: settings and session of the Tunelo CLI 1.x.
 *
 * A session is moved, never copied: its rotating refresh token used from two
 * places would be replayed and the IdP would revoke the grant. So the plain
 * copy is removed once the sealed one is saved, under the 1.x lock for the
 * CLI file. A CLI session not taken (the machine had one already) is left to
 * the CLI 1.x that still owns it.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	parseSession,
	resourceOfIssuer,
	withFileLock,
	writePrivateFile,
} from "@tunelo/client";
import {
	isRecord,
	legacyCliDir,
	parseSettings,
	saveSettings,
	settingsPath,
} from "./cli-settings.ts";
import { type PlainSession, identitySession } from "./session.ts";

const AGENT_SESSION_FILE = "tunelo-session.json";

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

async function adopt(dir: string, plain: PlainSession): Promise<boolean> {
	return identitySession(dir).adopt(plain, resourceOfIssuer(plain.issuer));
}

/** The plain session of tunelo 2.0 / hda in the config folder. */
async function importAgentSession(dir: string): Promise<void> {
	const file = join(dir, AGENT_SESSION_FILE);
	if (!existsSync(file)) return;
	const plain = parseSession(readJson(file));
	if (plain) await adopt(dir, plain);
	rmSync(file, { force: true });
}

/** Settings and session of the Tunelo CLI 1.x in `~/.tunelo`. */
async function importCliConfig(dir: string, home: string): Promise<void> {
	const legacyDir = legacyCliDir(home);
	const file = join(legacyDir, "config.json");
	if (!existsSync(file)) return;
	if (!existsSync(settingsPath(dir))) {
		saveSettings(parseSettings(readJson(file)), dir);
	}
	const before = readJson(file);
	if (!isRecord(before) || before.session === undefined) return;
	await withFileLock(join(legacyDir, "session.lock"), async () => {
		const raw = readJson(file);
		if (!isRecord(raw) || raw.session === undefined) return;
		const plain = parseSession(raw.session);
		if (plain && !(await adopt(dir, plain))) return;
		const { session: _moved, ...rest } = raw;
		writePrivateFile(file, `${JSON.stringify(rest, null, 2)}\n`);
	});
}

/** Moves what older installs left behind; cheap when there is nothing. */
export async function importLegacySignIns(
	dir: string,
	home: string = homedir(),
): Promise<void> {
	await importAgentSession(dir);
	await importCliConfig(dir, home);
}
