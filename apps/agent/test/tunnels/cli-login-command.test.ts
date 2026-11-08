import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSettings } from "../../src/identity/cli-settings.ts";
import { AGENT_CLIENT_ID, appResources, identitySession } from "../../src/identity/session.ts";
import { fakeJwt } from "../support/fake-idp.ts";

const state = vi.hoisted(() => ({
	pollFails: false,
	revoked: [] as string[],
	resources: [] as unknown[],
	polledFor: [] as string[],
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
}));
vi.mock("../../src/identity/agent-login.ts", async () => {
	const { appResources: resourcesOf } = await import("../../src/identity/session.ts");
	return {
		startAgentAuthorization: async (_e: unknown, issuer: string) => {
			state.resources.push(...Object.values(resourcesOf(issuer)));
			return { deviceCode: "dc", verificationUri: "https://idp.test/device", verificationUriComplete: null, userCode: "ABCD", expiresIn: 600, interval: 5 };
		},
		pollAgentTokens: async (_e: unknown, _issuer: string, _a: unknown, app: string) => {
			state.polledFor.push(app);
			if (state.pollFails) throw new Error("access_denied");
			return { accessToken: fakeJwt("new-account"), refreshToken: "new-refresh", idToken: fakeJwt("new-account"), expiresIn: 300 };
		},
	};
});
vi.mock("../../src/tunnels/open-browser.js", () => ({ openBrowser: async () => undefined }));

const { registerLoginCommands } = await import("../../src/tunnels/cli-login-command.js");

let dir = "";
const savedHome = process.env.TUNELO_HOME;

async function login(...args: string[]): Promise<void> {
	const program = new Command();
	registerLoginCommands(program);
	await program.parseAsync(["node", "tunelo", "login", ...args]);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "tunelo-login-"));
	process.env.TUNELO_HOME = dir;
	state.pollFails = false;
	state.revoked = [];
	state.resources = [];
	state.polledFor = [];
	await identitySession(dir).adopt({ issuer: "https://auth.hoandat.com", sub: "old-account", refreshToken: "old-refresh" }, "https://tunnel.hoandat.com");
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${String(code)}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedHome === undefined) delete process.env.TUNELO_HOME;
	else process.env.TUNELO_HOME = savedHome;
	rmSync(dir, { recursive: true, force: true });
});

describe("tunelo login --server", () => {
	test("a failed sign-in keeps the current session and default server", async () => {
		state.pollFails = true;
		await expect(login("--server", "https://tunnel.acme.test")).rejects.toThrow("exit 1");
		expect(state.revoked).toEqual([]);
		expect(identitySession(dir).info()?.sub).toBe("old-account");
		expect(loadSettings(dir).server).toBeUndefined();
	});

	test("a new server's session replaces the old one once signed in, sealed", async () => {
		await login("--server", "tunnel.acme.test");
		expect(identitySession(dir).info()).toEqual({ issuer: "https://auth.acme.test", sub: "new-account", clientId: AGENT_CLIENT_ID });
		// One approval for the three apps; the device code is redeemed for the tunnel's resource.
		expect(state.resources).toEqual(["https://tunnel.acme.test", "https://chat.acme.test/mcp", "https://localman.acme.test/mcp"]);
		expect(state.polledFor).toEqual(["tunnel"]);
		expect(identitySession(dir).covers("chat")).toBe(true);
		expect(state.revoked).toEqual(["old-refresh"]);
		expect(loadSettings(dir).server).toBe("https://tunnel.acme.test");
		for (const name of readdirSync(dir)) {
			expect(readFileSync(join(dir, name), "utf8")).not.toContain("new-refresh");
		}
	});

	test("a tunnel-only session of an older install is replaced by the one sign-in without --force", async () => {
		expect(identitySession(dir).info()?.clientId).toBe("tunelo-cli");
		await login();
		expect(identitySession(dir).info()).toMatchObject({ sub: "new-account", clientId: AGENT_CLIENT_ID });
		expect(state.revoked).toEqual(["old-refresh"]);
	});

	test("already signed in for the server: it still becomes the default", async () => {
		const resources = appResources("https://auth.hoandat.com");
		await identitySession(dir).replace(
			"https://auth.hoandat.com",
			{ accessToken: fakeJwt("old-account"), refreshToken: "agent-refresh", idToken: fakeJwt("old-account"), expiresIn: 300 },
			resources.tunnel,
			AGENT_CLIENT_ID,
			Object.values(resources),
		);
		state.revoked = [];
		await login("--server", "https://tunnel.hoandat.com");
		expect(state.resources).toEqual([]);
		expect(state.revoked).toEqual([]);
		expect(loadSettings(dir).server).toBe("https://tunnel.hoandat.com");
	});

	test("a stored session that no longer opens is signed in again without --force", async () => {
		const file = join(dir, "session.json");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { refreshToken: string };
		writeFileSync(file, JSON.stringify({ ...stored, refreshToken: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" }));
		await login();
		expect(identitySession(dir).info()?.sub).toBe("new-account");
		expect(await identitySession(dir).isUsable()).toBe(true);
	});

	test("--force signs in again even for the same server", async () => {
		await login("--force");
		expect(identitySession(dir).info()?.sub).toBe("new-account");
		expect(state.revoked).toEqual(["old-refresh"]);
	});
});
