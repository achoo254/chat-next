// The Keychain backend through a stand-in `security`: an item that does not
// exist (exit 44) and a Keychain that cannot be read now (locked, no GUI
// session) must stay apart. The second must never lead to a new key written
// over the real one, and must not stick once the Keychain opens.
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentitySession } from "../src/identity/session.ts";
import { KeyStoreUnavailableError, machineKey, seal, unseal } from "../src/keystore.ts";
import { tempDir } from "./harness.ts";

describe.runIf(process.platform === "darwin")("Keychain backend", () => {
	const saved = { path: process.env.PATH, keystore: process.env.TUNELO_KEYSTORE };
	let store = "";

	beforeEach(() => {
		const bin = tempDir("fake-security-");
		store = tempDir("fake-keychain-");
		// Items keyed by service and account; FAKE_KEYCHAIN_LOCKED makes every read fail like a locked Keychain.
		writeFileSync(
			join(bin, "security"),
			[
				"#!/bin/sh",
				'if [ "$1" = "find-generic-password" ]; then [ -f "$FAKE_KEYCHAIN/locked" ] && exit 51; [ -f "$FAKE_KEYCHAIN/$3.$5" ] || exit 44; cat "$FAKE_KEYCHAIN/$3.$5"; exit 0; fi',
				'if [ "$1" = "-i" ]; then read -r cmd u sflag service aflag account wflag value; printf "%s\\n" "$value" > "$FAKE_KEYCHAIN/$service.$account"; echo write >> "$FAKE_KEYCHAIN/writes.log"; exit 0; fi',
				"exit 1",
			].join("\n"),
		);
		chmodSync(join(bin, "security"), 0o755);
		process.env.PATH = `${bin}:${saved.path ?? ""}`;
		process.env.FAKE_KEYCHAIN = store;
		delete process.env.TUNELO_KEYSTORE;
	});

	afterEach(() => {
		process.env.PATH = saved.path;
		process.env.TUNELO_KEYSTORE = saved.keystore ?? "";
	});

	const lock = () => writeFileSync(join(store, "locked"), "");
	const unlock = () => rmSync(join(store, "locked"));
	const writes = () => (existsSync(join(store, "writes.log")) ? readFileSync(join(store, "writes.log"), "utf8").trim().split("\n").length : 0);

	it("creates the sealing key only when the Keychain has none", async () => {
		const dir = tempDir();
		const sealed = await seal(dir, "secret");
		expect(writes()).toBe(1);
		expect(await unseal(dir, sealed)).toBe("secret");
		expect(readdirSync(store)).toContain("com.hoandat.tunelo.session-key");
	});

	it("a locked Keychain is an error: no new key written, nothing cached, and it works once unlocked", async () => {
		const dir = tempDir();
		lock();
		await expect(seal(dir, "secret")).rejects.toBeInstanceOf(KeyStoreUnavailableError);
		await expect(machineKey(dir)).rejects.toBeInstanceOf(KeyStoreUnavailableError);
		expect(writes()).toBe(0);
		unlock();
		expect(await unseal(dir, await seal(dir, "after"))).toBe("after");
	});

	it("a session cannot be opened while the Keychain is locked, says so, and stays", async () => {
		const dir = tempDir();
		const session = new IdentitySession(dir, { sleep: async () => {} });
		await session.adopt({ issuer: "https://auth.example", sub: "acc", refreshToken: "rt-1" }, "https://tunnel.example");
		const key = readFileSync(join(store, "com.hoandat.tunelo.session-key"), "utf8");
		// Another process (no key in memory: the cache is per folder) while the Keychain is locked.
		const other = tempDir();
		copyFileSync(join(dir, "session.json"), join(other, "session.json"));
		lock();
		const later = new IdentitySession(other, { sleep: async () => {} });
		await expect(later.isUsable()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
		await expect(later.getAccessToken("https://tunnel.example")).rejects.toThrow(/unlock the Keychain/);
		expect(later.info()?.sub).toBe("acc");
		expect(readFileSync(join(store, "com.hoandat.tunelo.session-key"), "utf8")).toBe(key);
	});
});
