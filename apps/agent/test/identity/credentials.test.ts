import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { acceptsAccountToken } from "@tunelo/client";
import { describe, expect, test } from "vitest";
import {
	getConfigDir,
	getConfigPath,
	loadConfig,
	saveConfig,
} from "./config.js";
import { resolveCredential } from "./credentials.js";
import { legacyReminder } from "./display.js";
import { DEFAULT_SERVER_URL, resolveServerUrl } from "./server-url.js";
import { useTempHome } from "./test-support/temp-home.js";

useTempHome();

// Windows has no POSIX permission bits: files report 0o666 and directories
// 0o777 whatever the requested mode, so these mode-only tests run on POSIX.
const posixModes = process.platform === "win32" ? test.skip : test;

describe("config file", () => {
	posixModes("is written owner-only, directory included", () => {
		saveConfig({ key: "tunelo_x" });
		expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
		expect(statSync(getConfigDir()).mode & 0o777).toBe(0o700);
	});

	posixModes("tightens a file an older CLI left world-readable", () => {
		mkdirSync(getConfigDir(), { recursive: true });
		writeFileSync(getConfigPath(), "{}", { mode: 0o644 });
		saveConfig({ key: "tunelo_x" });
		expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
	});

	test("a corrupt file reads as empty", () => {
		mkdirSync(getConfigDir(), { recursive: true });
		writeFileSync(getConfigPath(), "{not json");
		expect(loadConfig()).toEqual({});
	});
});

describe("server and credentials", () => {
	test("a saved server on the old domain moves to the new one, once", () => {
		saveConfig({ server: "wss://tunnel.inetdev.io.vn" });
		const notices: string[] = [];
		const url = resolveServerUrl(undefined, (from, to) =>
			notices.push(`${from}>${to}`),
		);
		expect(url).toBe(DEFAULT_SERVER_URL);
		expect(loadConfig().server).toBe(DEFAULT_SERVER_URL);
		expect(notices).toEqual([
			`wss://tunnel.inetdev.io.vn>${DEFAULT_SERVER_URL}`,
		]);
		resolveServerUrl(undefined, () => notices.push("again"));
		expect(notices).toHaveLength(1);
	});

	test("a sign-in for the old domain's own tenant keeps its server", () => {
		const server = "https://tunnel.inetdev.io.vn";
		saveConfig({
			server,
			session: {
				issuer: "https://auth.inetdev.io.vn",
				sub: "acc_t",
				refreshToken: "rt",
			},
		});
		const notices: string[] = [];
		expect(resolveServerUrl(undefined, () => notices.push("moved"))).toBe(
			server,
		);
		expect(loadConfig().server).toBe(server);
		expect(notices).toEqual([]);
	});

	test("a hoandat sign-in saved with the old domain still moves", () => {
		saveConfig({
			server: "https://tunnel.inetdev.io.vn",
			session: {
				issuer: "https://auth.hoandat.com",
				sub: "acc_a",
				refreshToken: "rt",
			},
		});
		expect(resolveServerUrl()).toBe(DEFAULT_SERVER_URL);
	});

	test("the account session wins over a saved anonymous token", () => {
		saveConfig({
			key: "tunelo_anon",
			session: {
				issuer: "https://auth.hoandat.com",
				sub: "acc_a",
				refreshToken: "rt",
			},
		});
		const official = "https://tunnel.hoandat.com";
		expect(resolveCredential(undefined, official)).toMatchObject({
			kind: "account",
			sub: "acc_a",
		});
		expect(resolveCredential("tunelo_flag", official)).toMatchObject({
			kind: "key",
			anonymous: true,
		});
	});

	test("the account token never goes to another server", () => {
		const session = { issuer: "https://idp", sub: "acc_a", refreshToken: "rt" };
		saveConfig({ key: "tunelo_anon", session });
		expect(
			resolveCredential(undefined, "wss://tunnel.example.com"),
		).toMatchObject({
			kind: "key",
		});
		expect(acceptsAccountToken("ws://tunnel.hoandat.com", "https://idp")).toBe(
			false,
		);
		expect(acceptsAccountToken("ws://127.0.0.1:3001", "https://idp")).toBe(
			true,
		);
		saveConfig({ session });
		expect(resolveCredential(undefined, "https://evil.example")).toBeNull();
	});

	test("the account token only goes to the Tunelo of its own domain", () => {
		const hoandat = "https://auth.hoandat.com";
		expect(acceptsAccountToken("https://tunnel.hoandat.com", hoandat)).toBe(
			true,
		);
		expect(acceptsAccountToken("wss://tunnel.hoandat.com/", hoandat)).toBe(
			true,
		);
		expect(acceptsAccountToken("https://tunnel.acme.example", hoandat)).toBe(
			false,
		);
		expect(
			acceptsAccountToken(
				"https://tunnel.acme.example",
				"https://auth.acme.example",
			),
		).toBe(true);
		expect(acceptsAccountToken("https://x.tunnel.hoandat.com", hoandat)).toBe(
			false,
		);
	});

	test("an anonymous machine is reminded with the cutoff date", () => {
		expect(legacyReminder("2026-12-08T00:00:00.000Z")).toBe(
			"Anonymous token: it stops working on 2026-12-08. Run `tunelo login` to sign in with your account.",
		);
		expect(legacyReminder()).toContain("will stop working soon");
	});
});
