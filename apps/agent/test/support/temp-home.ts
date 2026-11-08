import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Assigning undefined to process.env would store the string "undefined". */
function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/**
 * Points the home dir (hence ~/.tunelo) at a fresh temp dir for every test.
 * os.homedir() reads HOME on POSIX but USERPROFILE on Windows, so set both.
 */
export function useTempHome(): { dir: () => string } {
	let dir = "";
	const originalHome = process.env.HOME;
	const originalProfile = process.env.USERPROFILE;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tunelo-home-"));
		process.env.HOME = dir;
		process.env.USERPROFILE = dir;
	});
	afterEach(() => {
		restoreEnv("HOME", originalHome);
		restoreEnv("USERPROFILE", originalProfile);
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir: () => dir };
}
