import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IdpEndpoints,
	OAuthResponseError,
	type TokenSet,
} from "@tunelo/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	AGENT_CLIENT_ID,
	IdentitySession,
	ResourceNotGrantedError,
	SESSION_FILE,
	type SessionDeps,
	SessionExpiredError,
	appResources,
} from "../../src/identity/session.ts";
import { seal } from "../../src/keystore.ts";
import { fakeJwt } from "../support/fake-idp.ts";

const endpoints: IdpEndpoints = {
	deviceAuthorization: "https://idp/device/auth",
	token: "https://idp/token",
	revocation: "https://idp/revoke",
};
const NOW = 1_800_000_000_000;
const TUNNEL = "https://tunnel.example";
const CHAT = "https://chat.example/mcp";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tunelo-session-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rotatingRefresh() {
	const used: { refreshToken: string; resource: string; clientId: string }[] = [];
	let n = 1;
	return {
		used,
		refresh: async (
			_e: IdpEndpoints,
			refreshToken: string,
			resource: string,
			clientId: string,
		): Promise<TokenSet> => {
			used.push({ refreshToken, resource, clientId });
			n++;
			return {
				accessToken: fakeJwt("acc_alice"),
				refreshToken: `rt-${n}`,
				idToken: null,
				expiresIn: 900,
			};
		},
	};
}

function deps(refresh: NonNullable<SessionDeps["refresh"]>, extra: SessionDeps = {}): SessionDeps {
	return {
		discover: async () => endpoints,
		refresh,
		sleep: async () => {},
		now: () => NOW,
		...extra,
	};
}

/** Signs in as acc_alice with refresh token rt-1 and an access token expiring at `expiresAt`. */
async function signedIn(session: IdentitySession, expiresAt: number): Promise<void> {
	await session.adopt(
		{
			issuer: "https://idp",
			sub: "acc_alice",
			refreshToken: "rt-1",
			accessToken: "at-old",
			accessTokenExpiresAt: expiresAt,
		},
		TUNNEL,
	);
}

/** Signs in as tunelo-agent for the tunnel and Chat, with an access token of the tunnel expiring at `expiresAt`. */
async function signedInAgent(session: IdentitySession, expiresAt: number): Promise<void> {
	await session.replace(
		"https://idp",
		{ accessToken: "at-old", refreshToken: "rt-1", idToken: fakeJwt("acc_alice"), expiresIn: (expiresAt - NOW) / 1000 },
		TUNNEL,
		AGENT_CLIENT_ID,
		[TUNNEL, CHAT],
	);
}

function sessionText(): string {
	return readFileSync(join(dir, SESSION_FILE), "utf8");
}

const posixModes = process.platform === "win32" ? test.skip : test;

describe("identity session", () => {
	test("keeps no token in plain text on disk", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW - 1);
		const token = await session.getAccessToken(TUNNEL);
		for (const name of readdirSync(dir)) {
			const text = readFileSync(join(dir, name), "utf8");
			for (const secret of ["rt-1", "rt-2", "at-old", token]) {
				expect(text, name).not.toContain(secret);
			}
		}
		expect(session.info()).toEqual({ issuer: "https://idp", sub: "acc_alice", clientId: "tunelo-cli" });
		expect(JSON.parse(sessionText()).refreshToken).toMatch(/^v1\./);
	});

	posixModes("writes the session owner-only", async () => {
		const session = new IdentitySession(dir, deps(rotatingRefresh().refresh));
		await signedIn(session, NOW + 600_000);
		expect(statSync(join(dir, SESSION_FILE)).mode & 0o777).toBe(0o600);
	});

	test("a token that is still valid is used as is", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW + 10 * 60_000);
		expect(await session.getAccessToken(TUNNEL)).toBe("at-old");
		expect(fake.used).toEqual([]);
	});

	test("an expiring token is refreshed for its resource and the rotated refresh token saved", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedInAgent(session, NOW + 30_000);
		const token = await session.getAccessToken(TUNNEL);
		expect(token).not.toBe("at-old");
		expect(fake.used).toEqual([{ refreshToken: "rt-1", resource: TUNNEL, clientId: AGENT_CLIENT_ID }]);
		// A second process reads the rotated token from disk and needs no refresh.
		const other = new IdentitySession(dir, deps(fake.refresh));
		expect(await other.getAccessToken(TUNNEL)).toBe(token);
		await other.getAccessToken(CHAT);
		expect(fake.used.map((u) => u.refreshToken)).toEqual(["rt-1", "rt-2"]);
		expect(fake.used[1]?.resource).toBe(CHAT);
	});

	test("concurrent callers rotate the refresh token only once", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW - 1);
		const others = [new IdentitySession(dir, deps(fake.refresh)), new IdentitySession(dir, deps(fake.refresh))];
		const tokens = await Promise.all([session, ...others].map((s) => s.getAccessToken(TUNNEL)));
		expect(fake.used.map((u) => u.refreshToken)).toEqual(["rt-1"]);
		expect(new Set(tokens).size).toBe(1);
	});

	test("on invalid_grant, a refresh token another writer saved meanwhile is read and tried once", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW - 1);
		let first = true;
		const refresh: NonNullable<SessionDeps["refresh"]> = async (e, rt, resource, clientId) => {
			if (first) {
				first = false;
				// A writer that skipped the lock rotated the token after this process read the file.
				const file = JSON.parse(sessionText()) as Record<string, unknown>;
				file.refreshToken = await seal(dir, "rt-from-other");
				writeFileSync(join(dir, SESSION_FILE), JSON.stringify(file));
				throw new OAuthResponseError("invalid_grant", 400);
			}
			return fake.refresh(e, rt, resource, clientId);
		};
		const retried = new IdentitySession(dir, deps(refresh));
		expect(await retried.getAccessToken(TUNNEL)).toBeTruthy();
		expect(fake.used.map((u) => u.refreshToken)).toEqual(["rt-from-other"]);
	});

	test("invalid_grant with no newer refresh token ends the session", async () => {
		const session = new IdentitySession(
			dir,
			deps(async () => {
				throw new OAuthResponseError("invalid_grant", 400);
			}),
		);
		await signedIn(session, NOW - 1);
		await expect(session.getAccessToken(TUNNEL)).rejects.toBeInstanceOf(SessionExpiredError);
		expect(session.info()).toBeUndefined();
	});

	test("a rate-limited refresh keeps the session and retries", async () => {
		const fake = rotatingRefresh();
		let calls = 0;
		const session = new IdentitySession(
			dir,
			deps(async (e, rt, resource, clientId) => {
				if (++calls === 1) throw new OAuthResponseError("too_many_requests", 429);
				return fake.refresh(e, rt, resource, clientId);
			}),
		);
		await signedIn(session, NOW - 1);
		await session.getAccessToken(TUNNEL);
		expect(fake.used.map((u) => u.refreshToken)).toEqual(["rt-1"]);
		expect(session.info()?.sub).toBe("acc_alice");
	});

	test("network failures are retried with backoff", async () => {
		const fake = rotatingRefresh();
		let calls = 0;
		const waits: number[] = [];
		const session = new IdentitySession(
			dir,
			deps(
				async (e, rt, resource, clientId) => {
					if (++calls < 3) throw new TypeError("fetch failed");
					return fake.refresh(e, rt, resource, clientId);
				},
				{ sleep: async (ms) => void waits.push(ms) },
			),
		);
		await signedIn(session, NOW - 1);
		await session.getAccessToken(TUNNEL);
		expect(waits).toEqual([1000, 2000]);
	});

	test("no session means sign in first", async () => {
		await expect(new IdentitySession(dir).getAccessToken(TUNNEL)).rejects.toBeInstanceOf(SessionExpiredError);
	});

	test("a sealed refresh token that does not open (changed, other key) asks to sign in again", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW - 1);
		const file = JSON.parse(sessionText()) as { refreshToken: string };
		const [version, iv, data = ""] = file.refreshToken.split(".");
		file.refreshToken = [version, iv, `${data.slice(0, -2)}AA`].join(".");
		writeFileSync(join(dir, SESSION_FILE), JSON.stringify({ ...JSON.parse(sessionText()), refreshToken: file.refreshToken }));
		await expect(session.getAccessToken(TUNNEL)).rejects.toThrow(/sign-in on this machine cannot be opened/);
		expect(fake.used).toEqual([]);
	});

	test("a new sign-in replaces the session and revokes the grant it held", async () => {
		const revoked: { refreshToken: string; clientId: string }[] = [];
		const session = new IdentitySession(
			dir,
			deps(rotatingRefresh().refresh, {
				revoke: async (_e, refreshToken, clientId) => void revoked.push({ refreshToken, clientId }),
			}),
		);
		await signedIn(session, NOW - 1);
		const { info, revokeError } = await session.replace(
			"https://idp",
			{ accessToken: fakeJwt("acc_bob"), refreshToken: "rt-new", idToken: fakeJwt("acc_bob"), expiresIn: 300 },
			TUNNEL,
		);
		expect(revokeError).toBeUndefined();
		expect(info.sub).toBe("acc_bob");
		expect(revoked).toEqual([{ refreshToken: "rt-1", clientId: "tunelo-cli" }]);
		expect(sessionText()).not.toContain("rt-new");
	});

	test("sign-out forgets the session even when revoking fails", async () => {
		const session = new IdentitySession(
			dir,
			deps(rotatingRefresh().refresh, {
				revoke: async () => {
					throw new Error("offline");
				},
			}),
		);
		await signedIn(session, NOW - 1);
		const out = await session.signOut();
		expect(out?.revokeError?.message).toBe("offline");
		expect(session.info()).toBeUndefined();
		expect(await session.signOut()).toBeNull();
	});

	test("a resource outside the grant is refused before any request, so the refresh token is not burnt", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		await signedIn(session, NOW - 1);
		await expect(session.getAccessToken(CHAT)).rejects.toBeInstanceOf(ResourceNotGrantedError);
		await expect(session.getAppToken("chat")).rejects.toBeInstanceOf(ResourceNotGrantedError);
		expect(fake.used).toEqual([]);
		expect(session.covers("chat")).toBe(false);
		expect(session.covers("localman")).toBe(false);
	});

	test("every refresh of a tunelo-agent session names its resource", async () => {
		const fake = rotatingRefresh();
		const session = new IdentitySession(dir, deps(fake.refresh));
		const issuer = "https://auth.example";
		const resources = appResources(issuer);
		expect(resources).toEqual({
			tunnel: "https://tunnel.example",
			chat: "https://chat.example/mcp",
			localman: "https://localman.example/mcp",
		});
		await session.replace(
			issuer,
			{ accessToken: "at-old", refreshToken: "rt-1", idToken: fakeJwt("acc_alice"), expiresIn: 0 },
			resources.tunnel,
			AGENT_CLIENT_ID,
			Object.values(resources),
		);
		for (const app of ["chat", "localman", "tunnel"] as const) {
			expect(session.covers(app)).toBe(true);
			await session.getAppToken(app);
		}
		expect(fake.used.map((u) => u.resource)).toEqual([resources.chat, resources.localman, resources.tunnel]);
		expect(fake.used.every((u) => u.clientId === AGENT_CLIENT_ID)).toBe(true);
		expect(JSON.parse(sessionText()).resources).toEqual([resources.tunnel, resources.chat, resources.localman]);
	});

	test("a session file written before resources were recorded keeps what its client always held", async () => {
		const session = new IdentitySession(dir, deps(rotatingRefresh().refresh));
		await session.adopt({ issuer: "https://auth.example", sub: "acc_alice", refreshToken: "rt-1" }, "https://tunnel.example");
		const stored = JSON.parse(sessionText()) as Record<string, unknown>;
		delete stored.resources;
		writeFileSync(join(dir, SESSION_FILE), JSON.stringify(stored));
		expect(session.covers("tunnel")).toBe(true);
		expect(session.covers("chat")).toBe(false);
		writeFileSync(join(dir, SESSION_FILE), JSON.stringify({ ...stored, clientId: AGENT_CLIENT_ID }));
		expect(session.covers("chat")).toBe(true);
		expect(session.covers("localman")).toBe(true);
	});
});
