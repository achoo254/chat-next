import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSettings } from "../../src/identity/cli-settings.ts";
import { importLegacySignIns } from "../../src/identity/legacy-import.ts";
import { identitySession } from "../../src/identity/session.ts";

let root = "";
let dir = "";
let home = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tunelo-import-"));
	dir = join(root, "cfg");
	home = join(root, "home");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, ".tunelo"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cliConfig = () => join(home, ".tunelo", "config.json");

function writeCliConfig(value: unknown): void {
	writeFileSync(cliConfig(), JSON.stringify(value));
}

function filesContain(folder: string, text: string): string[] {
	return readdirSync(folder).filter((name) => {
		const path = join(folder, name);
		try {
			return readFileSync(path, "utf8").includes(text);
		} catch {
			return false;
		}
	});
}

describe("moving older sign-ins", () => {
	test("takes the session of tunelo 2.0 and removes its plain-text file", async () => {
		writeFileSync(join(dir, "tunelo-session.json"), JSON.stringify({ issuer: "https://auth.hoandat.com", sub: "acc_m", refreshToken: "rt-agent" }));
		await importLegacySignIns(dir, home);
		expect(identitySession(dir).info()?.sub).toBe("acc_m");
		expect(existsSync(join(dir, "tunelo-session.json"))).toBe(false);
		expect(filesContain(dir, "rt-agent")).toEqual([]);
	});

	test("takes the settings and session of the CLI 1.x, leaving its other settings", async () => {
		writeCliConfig({
			server: "https://tunnel.example",
			key: "tunelo_anon",
			deviceId: "dev-1",
			session: { issuer: "https://auth.example", sub: "acc_c", refreshToken: "rt-cli" },
		});
		await importLegacySignIns(dir, home);
		expect(identitySession(dir).info()?.sub).toBe("acc_c");
		expect(loadSettings(dir)).toEqual({ server: "https://tunnel.example", key: "tunelo_anon", deviceId: "dev-1" });
		const left = JSON.parse(readFileSync(cliConfig(), "utf8")) as Record<string, unknown>;
		expect(left.session).toBeUndefined();
		expect(left.deviceId).toBe("dev-1");
		expect(filesContain(join(home, ".tunelo"), "rt-cli")).toEqual([]);
		expect(filesContain(dir, "rt-cli")).toEqual([]);
	});

	test("the machine's own session wins; the CLI's stays with the CLI", async () => {
		writeFileSync(join(dir, "tunelo-session.json"), JSON.stringify({ issuer: "https://auth.hoandat.com", sub: "acc_m", refreshToken: "rt-agent" }));
		writeCliConfig({ session: { issuer: "https://auth.hoandat.com", sub: "acc_c", refreshToken: "rt-cli" } });
		await importLegacySignIns(dir, home);
		expect(identitySession(dir).info()?.sub).toBe("acc_m");
		// Not moved, so not removed: the CLI 1.x still uses its own grant.
		expect(JSON.parse(readFileSync(cliConfig(), "utf8")).session.sub).toBe("acc_c");
	});

	test("runs once: nothing to do the second time, and a later CLI setting does not overwrite tunelo's", async () => {
		writeCliConfig({ server: "https://tunnel.a" });
		await importLegacySignIns(dir, home);
		writeCliConfig({ server: "https://tunnel.b" });
		await importLegacySignIns(dir, home);
		expect(loadSettings(dir).server).toBe("https://tunnel.a");
		expect(identitySession(dir).info()).toBeUndefined();
	});
});
