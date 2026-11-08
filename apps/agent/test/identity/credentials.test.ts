import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptsAccountToken } from "@tunelo/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSettings, saveSettings, settingsPath } from "../../src/identity/cli-settings.ts";
import { resolveCredential } from "../../src/identity/credentials.ts";
import { identitySession } from "../../src/identity/session.ts";
import { legacyReminder } from "../../src/tunnels/display.js";
import { DEFAULT_SERVER_URL, resolveServerUrl } from "../../src/tunnels/server-url.js";

let dir = "";
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "tunelo-cfg-")), "tunelo");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

// Windows has no POSIX permission bits: files report 0o666 and directories
// 0o777 whatever the requested mode, so these mode-only tests run on POSIX.
const posixModes = process.platform === "win32" ? test.skip : test;

function signIn(issuer: string, sub: string): Promise<boolean> {
	return identitySession(dir).adopt({ issuer, sub, refreshToken: "rt" }, "https://tunnel.example");
}

describe("settings file", () => {
	posixModes("is written owner-only, directory included", () => {
		saveSettings({ key: "tunelo_x" }, dir);
		expect(statSync(settingsPath(dir)).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	posixModes("tightens a file left world-readable", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(settingsPath(dir), "{}", { mode: 0o644 });
		saveSettings({ key: "tunelo_x" }, dir);
		expect(statSync(settingsPath(dir)).mode & 0o777).toBe(0o600);
	});

	test("a corrupt file reads as empty", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(settingsPath(dir), "{not json");
		expect(loadSettings(dir)).toEqual({});
	});
});

describe("server and credentials", () => {
	test("a saved server on the old domain moves to the new one, once", () => {
		saveSettings({ server: "wss://tunnel.inetdev.io.vn" }, dir);
		const notices: string[] = [];
		const url = resolveServerUrl(undefined, (from, to) => notices.push(`${from}>${to}`), dir);
		expect(url).toBe(DEFAULT_SERVER_URL);
		expect(loadSettings(dir).server).toBe(DEFAULT_SERVER_URL);
		expect(notices).toEqual([`wss://tunnel.inetdev.io.vn>${DEFAULT_SERVER_URL}`]);
		resolveServerUrl(undefined, () => notices.push("again"), dir);
		expect(notices).toHaveLength(1);
	});

	test("a sign-in for the old domain's own tenant keeps its server", async () => {
		const server = "https://tunnel.inetdev.io.vn";
		saveSettings({ server }, dir);
		await signIn("https://auth.inetdev.io.vn", "acc_t");
		const notices: string[] = [];
		expect(resolveServerUrl(undefined, () => notices.push("moved"), dir)).toBe(server);
		expect(loadSettings(dir).server).toBe(server);
		expect(notices).toEqual([]);
	});

	test("a hoandat sign-in saved with the old domain still moves", async () => {
		saveSettings({ server: "https://tunnel.inetdev.io.vn" }, dir);
		await signIn("https://auth.hoandat.com", "acc_a");
		expect(resolveServerUrl(undefined, undefined, dir)).toBe(DEFAULT_SERVER_URL);
	});

	test("the account session wins over a saved anonymous token", async () => {
		saveSettings({ key: "tunelo_anon" }, dir);
		await signIn("https://auth.hoandat.com", "acc_a");
		const official = "https://tunnel.hoandat.com";
		expect(resolveCredential(undefined, official, dir)).toMatchObject({ kind: "account", sub: "acc_a" });
		expect(resolveCredential("tunelo_flag", official, dir)).toMatchObject({ kind: "key", anonymous: true });
	});

	test("the account token never goes to another server", async () => {
		saveSettings({ key: "tunelo_anon" }, dir);
		await signIn("https://idp", "acc_a");
		expect(resolveCredential(undefined, "wss://tunnel.example.com", dir)).toMatchObject({ kind: "key" });
		expect(acceptsAccountToken("ws://tunnel.hoandat.com", "https://idp")).toBe(false);
		expect(acceptsAccountToken("ws://127.0.0.1:3001", "https://idp")).toBe(true);
		saveSettings({}, dir);
		expect(resolveCredential(undefined, "https://evil.example", dir)).toBeNull();
	});

	test("the account token only goes to the Tunelo of its own domain", () => {
		const hoandat = "https://auth.hoandat.com";
		expect(acceptsAccountToken("https://tunnel.hoandat.com", hoandat)).toBe(true);
		expect(acceptsAccountToken("wss://tunnel.hoandat.com/", hoandat)).toBe(true);
		expect(acceptsAccountToken("https://tunnel.acme.example", hoandat)).toBe(false);
		expect(acceptsAccountToken("https://tunnel.acme.example", "https://auth.acme.example")).toBe(true);
		expect(acceptsAccountToken("https://x.tunnel.hoandat.com", hoandat)).toBe(false);
	});

	test("an anonymous machine is reminded with the cutoff date", () => {
		expect(legacyReminder("2026-12-08T00:00:00.000Z")).toBe(
			"Anonymous token: it stops working on 2026-12-08. Run `tunelo login` to sign in with your account.",
		);
		expect(legacyReminder()).toContain("will stop working soon");
	});
});
