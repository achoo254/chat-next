import {
	type IdpEndpoints,
	OAuthResponseError,
	type TokenSet,
} from "@tunelo/client";
import { describe, expect, test } from "vitest";
import { loadConfig, saveConfig } from "./config.js";
import { SessionExpiredError, getAccessToken } from "./idp-session.js";
import { fakeJwt } from "./test-support/fake-idp.js";
import { useTempHome } from "./test-support/temp-home.js";

useTempHome();

const endpoints: IdpEndpoints = {
	deviceAuthorization: "https://idp/device/auth",
	token: "https://idp/token",
	revocation: null,
};
const NOW = 1_800_000_000_000;

function signedIn(expiresAt: number): void {
	saveConfig({
		session: {
			issuer: "https://idp",
			sub: "acc_alice",
			refreshToken: "rt-1",
			accessToken: "at-old",
			accessTokenExpiresAt: expiresAt,
		},
	});
}

function rotatingRefresh() {
	const used: string[] = [];
	let n = 1;
	return {
		used,
		refresh: async (
			_e: IdpEndpoints,
			refreshToken: string,
		): Promise<TokenSet> => {
			used.push(refreshToken);
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

const deps = (refresh: (e: IdpEndpoints, rt: string) => Promise<TokenSet>) => ({
	discover: async () => endpoints,
	refresh,
	sleep: async () => {},
	now: () => NOW,
});

describe("idp session", () => {
	test("a token that is still valid is used as is", async () => {
		signedIn(NOW + 10 * 60_000);
		const fake = rotatingRefresh();
		expect(await getAccessToken(deps(fake.refresh))).toBe("at-old");
		expect(fake.used).toEqual([]);
	});

	test("an expiring token is refreshed and the rotated refresh token saved", async () => {
		signedIn(NOW + 30_000);
		const fake = rotatingRefresh();
		const token = await getAccessToken(deps(fake.refresh));
		expect(token).not.toBe("at-old");
		expect(fake.used).toEqual(["rt-1"]);
		expect(loadConfig().session).toMatchObject({
			refreshToken: "rt-2",
			accessTokenExpiresAt: NOW + 900_000,
		});
	});

	test("concurrent callers rotate the refresh token only once", async () => {
		signedIn(NOW - 1);
		const fake = rotatingRefresh();
		const tokens = await Promise.all([
			getAccessToken(deps(fake.refresh)),
			getAccessToken(deps(fake.refresh)),
			getAccessToken(deps(fake.refresh)),
		]);
		expect(fake.used).toEqual(["rt-1"]);
		expect(new Set(tokens).size).toBe(1);
	});

	test("invalid_grant ends the session", async () => {
		signedIn(NOW - 1);
		const refused = async (): Promise<TokenSet> => {
			throw new OAuthResponseError("invalid_grant", 400);
		};
		await expect(getAccessToken(deps(refused))).rejects.toBeInstanceOf(
			SessionExpiredError,
		);
		expect(loadConfig().session).toBeUndefined();
	});

	test("a rate-limited refresh keeps the session and retries", async () => {
		signedIn(NOW - 1);
		const fake = rotatingRefresh();
		let calls = 0;
		const limited = async (e: IdpEndpoints, rt: string): Promise<TokenSet> => {
			if (++calls === 1) throw new OAuthResponseError("too_many_requests", 429);
			return fake.refresh(e, rt);
		};
		await getAccessToken(deps(limited));
		expect(loadConfig().session?.refreshToken).toBe("rt-2");
	});

	test("network failures are retried with backoff", async () => {
		signedIn(NOW - 1);
		const fake = rotatingRefresh();
		let calls = 0;
		const flaky = async (e: IdpEndpoints, rt: string): Promise<TokenSet> => {
			if (++calls < 3) throw new TypeError("fetch failed");
			return fake.refresh(e, rt);
		};
		const waits: number[] = [];
		await getAccessToken({
			...deps(flaky),
			sleep: async (ms) => void waits.push(ms),
		});
		expect(waits).toEqual([1000, 2000]);
		expect(loadConfig().session?.refreshToken).toBe("rt-2");
	});

	test("no session means sign in first", async () => {
		await expect(getAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
	});
});
