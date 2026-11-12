import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSettings } from "../../src/identity/cli-settings.ts";
import { AGENT_CLIENT_ID, appResources, identitySession } from "../../src/identity/session.ts";
import type { MachineSetupDeps } from "../../src/commands/login.ts";
import { fakeJwt } from "../support/fake-idp.ts";

const state = vi.hoisted(() => ({
	pollFails: false,
	revoked: [] as string[],
	resources: [] as unknown[],
	polledFor: [] as string[],
	complete: null as string | null,
	opened: [] as string[],
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
			return { deviceCode: "dc", verificationUri: "https://idp.test/device", verificationUriComplete: state.complete, userCode: "ABCD", expiresIn: 600, interval: 5 };
		},
		pollAgentTokens: async (_e: unknown, _issuer: string, _a: unknown, app: string) => {
			state.polledFor.push(app);
			if (state.pollFails) throw new Error("access_denied");
			return { accessToken: fakeJwt("new-account"), refreshToken: "new-refresh", idToken: fakeJwt("new-account"), expiresIn: 300 };
		},
	};
});
vi.mock("../../src/tunnels/open-browser.js", () => ({
	openBrowser: async (url: string) => {
		state.opened.push(url);
	},
}));

const { registerLoginCommand } = await import("../../src/tunnels/cli-login-command.js");

let dir = "";
const savedHome = process.env.TUNELO_HOME;

/** The machine's side of `tunelo login`: a fake service that registers by itself once asked. */
function fakeSetup(over: Partial<MachineSetupDeps> = {}) {
	let running = false;
	let registered = false;
	let now = 0;
	const calls: string[] = [];
	const deps: MachineSetupDeps = {
		checkService: async () => undefined,
		isRunning: async () => running,
		installService: async () => {
			calls.push("install");
			running = true;
			return "launchd";
		},
		retryRegistration: async (_dir, signedInNow) => {
			calls.push(`retry ${String(signedInNow)}`);
		},
		apps: async () => {
			calls.push("apps");
			// The service adds the machine on its own a moment after it was asked.
			const chat = registered ? { status: "ok" as const, detail: "in AI Agent (machine 7)" } : { status: "waiting" as const, detail: "adding" };
			registered = calls.filter((c) => c === "apps").length >= 2;
			return { tunnel: { status: "ok", detail: "" }, chat, localman: { status: "ok", detail: "" } };
		},
		machineName: async () => "mac-mini",
		keepRunningLoggedOut: async () => null,
		serviceDiskAccess: async () => "not-applicable",
		openDiskAccessSettings: () => undefined,
		sleep: async (ms) => {
			now += ms;
		},
		now: () => now,
		log: (line) => calls.push(`log ${line}`),
		...over,
	};
	return { deps, calls };
}

let setup = fakeSetup();

async function login(...args: string[]): Promise<void> {
	const program = new Command();
	registerLoginCommand(program, setup.deps);
	await program.parseAsync(["node", "tunelo", "login", ...args]);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "tunelo-login-"));
	process.env.TUNELO_HOME = dir;
	state.pollFails = false;
	state.revoked = [];
	state.resources = [];
	state.polledFor = [];
	state.complete = null;
	state.opened = [];
	setup = fakeSetup();
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

describe("tunelo login connects the machine", () => {
	test("opens the link with the code filled in, then starts the service, which adds the machine by itself", async () => {
		state.complete = "https://idp.test/device?user_code=ABCD";
		await login("--force");
		expect(state.opened).toEqual(["https://idp.test/device?user_code=ABCD"]);
		const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		expect(printed).toContain("  Code: ABCD (type it if the page asks; open https://idp.test/device on another device)");
		// Installed, asked to register now (after a new sign-in), then waited for: tunelo itself registers nothing.
		expect(setup.calls.filter((c) => !c.startsWith("log") && c !== "apps")).toEqual(["install", "retry true"]);
		expect(setup.calls.at(-1)).toMatch(/^log {3}✓ Connected this machine \(mac-mini\)\. Open https:\/\/chat\.hoandat\.com\/ai to use it\.$/);
	});

	test("without a link with the code, the plain page opens and the code is printed", async () => {
		await login("--force");
		expect(state.opened).toEqual(["https://idp.test/device"]);
	});

	test("run again on a connected machine: no new sign-in, nothing installed, only checked", async () => {
		const resources = appResources("https://auth.hoandat.com");
		await identitySession(dir).replace(
			"https://auth.hoandat.com",
			{ accessToken: fakeJwt("old-account"), refreshToken: "agent-refresh", idToken: fakeJwt("old-account"), expiresIn: 300 },
			resources.tunnel,
			AGENT_CLIENT_ID,
			Object.values(resources),
		);
		setup = fakeSetup({
			isRunning: async () => true,
			apps: async () => ({ tunnel: { status: "ok", detail: "" }, chat: { status: "ok", detail: "in AI Agent (machine 7)" }, localman: { status: "ok", detail: "" } }),
		});
		await login();
		expect(state.resources).toEqual([]);
		expect(setup.calls.filter((c) => !c.startsWith("log"))).toEqual(["retry false"]);
	});

	test("a machine Chat does not take ends with the reason and exit 1", async () => {
		setup = fakeSetup({
			isRunning: async () => true,
			apps: async () => ({
				tunnel: { status: "ok", detail: "" },
				chat: { status: "error", detail: "the account already has 20 machines", retryAt: 10_000_000 },
				localman: { status: "ok", detail: "" },
			}),
		});
		await expect(login("--force")).rejects.toThrow("exit 1");
		expect(setup.calls.some((c) => c.includes("20 machines"))).toBe(true);
	});

	test("a machine that cannot run the service is told before the sign-in, which then serves tunnels only", async () => {
		setup = fakeSetup({
			checkService: async () => {
				throw new Error("no systemd user session");
			},
		});
		await login("--force");
		const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		expect(printed.indexOf("  no systemd user session.")).toBeLessThan(printed.findIndex((l) => l.includes("Approve this machine")));
		expect(setup.calls.filter((c) => !c.startsWith("log"))).toEqual([]);
	});

	test("a removed machine is allowed back only by a new sign-in", async () => {
		const { ConfigStore } = await import("../../src/config.ts");
		new ConfigStore(dir).update((c) => (c.machineRemoved = true));
		await login("--force");
		expect(new ConfigStore(dir).get().machineRemoved).toBeUndefined();
	});
});
