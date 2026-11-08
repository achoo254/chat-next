import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StoredSession, TuneloConfig } from "./config.js";

const state = vi.hoisted(() => ({
	config: {} as TuneloConfig,
	pollFails: false,
	revoked: [] as string[],
	saved: [] as string[],
}));

vi.mock("./config.js", () => ({
	loadConfig: () => state.config,
	updateConfig: (update: (config: TuneloConfig) => TuneloConfig) => {
		state.config = update(state.config);
	},
}));
vi.mock("@tunelo/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tunelo/client")>()),
	discover: async () => ({
		deviceAuthorization: "https://idp.test/device",
		token: "https://idp.test/token",
		revocation: "https://idp.test/revoke",
	}),
	revokeToken: async (_endpoints: unknown, refreshToken: string) => {
		state.revoked.push(refreshToken);
	},
	deviceNameForIdp: () => "test-machine",
	startDeviceAuthorization: async () => ({
		verificationUri: "https://idp.test/device",
		userCode: "ABCD",
	}),
	pollForTokens: async () => {
		if (state.pollFails) throw new Error("access_denied");
		return {};
	},
}));
vi.mock("./idp-session.js", () => ({
	sessionFromTokens: (issuer: string): StoredSession => ({
		issuer,
		sub: "new-account",
		refreshToken: "new-refresh",
	}),
	saveSession: (session: StoredSession) => {
		state.saved.push(session.issuer);
		state.config = { ...state.config, session };
	},
	clearSession: () => undefined,
}));
vi.mock("./open-browser.js", () => ({ openBrowser: async () => undefined }));

const { registerLoginCommands } = await import("./cli-login-command.js");

const PRIMARY: StoredSession = {
	issuer: "https://auth.hoandat.com",
	sub: "old-account",
	refreshToken: "old-refresh",
};

async function login(...args: string[]): Promise<void> {
	const program = new Command();
	registerLoginCommands(program);
	await program.parseAsync(["node", "tunelo", "login", ...args]);
}

describe("tunelo login --server", () => {
	beforeEach(() => {
		state.config = { session: PRIMARY };
		state.pollFails = false;
		state.revoked = [];
		state.saved = [];
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit ${String(code)}`);
		});
	});

	test("a failed sign-in keeps the current session and default server", async () => {
		state.pollFails = true;
		await expect(login("--server", "https://tunnel.acme.test")).rejects.toThrow(
			"exit 1",
		);
		expect(state.revoked).toEqual([]);
		expect(state.config).toEqual({ session: PRIMARY });
	});

	test("a new server's session replaces the old one once signed in", async () => {
		await login("--server", "tunnel.acme.test");
		expect(state.saved).toEqual(["https://auth.acme.test"]);
		expect(state.revoked).toEqual(["old-refresh"]);
		expect(state.config.server).toBe("https://tunnel.acme.test");
	});

	test("already signed in for the server: it still becomes the default", async () => {
		await login("--server", "https://tunnel.hoandat.com");
		expect(state.saved).toEqual([]);
		expect(state.revoked).toEqual([]);
		expect(state.config.server).toBe("https://tunnel.hoandat.com");
	});
});
