import {
	DeviceLoginError,
	deviceNameForIdp,
	discover,
	pollForTokens,
	startDeviceAuthorization,
} from "@tunelo/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type FakeIdp,
	fakeJwt,
	startFakeIdp,
} from "./test-support/fake-idp.js";

let idp: FakeIdp;
beforeEach(async () => {
	idp = await startFakeIdp();
});
afterEach(() => idp.close());

/** Records the waits instead of sleeping. */
function fakeClock() {
	let now = 0;
	const waits: number[] = [];
	return {
		waits,
		now: () => now,
		sleep: async (ms: number) => {
			waits.push(ms);
			now += ms;
		},
	};
}

const pending = { status: 400, body: { error: "authorization_pending" } };
const success = {
	status: 200,
	body: {
		access_token: fakeJwt("acc_alice"),
		refresh_token: "rt-1",
		id_token: fakeJwt("acc_alice"),
		expires_in: 900,
		token_type: "Bearer",
	},
};

describe("device flow", () => {
	test("asks for the Tunelo resource and scopes", async () => {
		const endpoints = await discover(idp.issuer);
		const auth = await startDeviceAuthorization(
			endpoints,
			"my-mac",
			"https://tunnel.hoandat.com",
		);
		expect(auth.userCode).toBe("WDJB-MJHT");
		const form = idp.requests[0]?.form;
		expect(form?.get("client_id")).toBe("tunelo-cli");
		expect(form?.get("resource")).toBe("https://tunnel.hoandat.com");
		expect(form?.get("scope")).toBe(
			"openid offline_access tunnels:open tunnels:read",
		);
		expect(form?.get("device_name")).toBe("my-mac");
	});

	test("waits through authorization_pending and slows down on slow_down", async () => {
		idp.tokenReplies.push(
			pending,
			{ status: 400, body: { error: "slow_down" } },
			pending,
			success,
		);
		const endpoints = await discover(idp.issuer);
		const auth = await startDeviceAuthorization(
			endpoints,
			"mac",
			"https://tunnel.hoandat.com",
		);
		const clock = fakeClock();
		const tokens = await pollForTokens(endpoints, auth, clock);
		expect(tokens).toMatchObject({ refreshToken: "rt-1", expiresIn: 900 });
		expect(clock.waits).toEqual([5000, 5000, 10000, 10000]);
		const grant = idp.requests.find((r) => r.path === "/token")?.form;
		expect(grant?.get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:device_code",
		);
		expect(grant?.get("device_code")).toBe("dev-code");
	});

	test("a 429 from the IdP slows down instead of failing", async () => {
		idp.tokenReplies.push(
			{ status: 429, body: { error: "too_many_requests" } },
			success,
		);
		const endpoints = await discover(idp.issuer);
		const auth = await startDeviceAuthorization(
			endpoints,
			"mac",
			"https://tunnel.hoandat.com",
		);
		const clock = fakeClock();
		await pollForTokens(endpoints, auth, clock);
		expect(clock.waits).toEqual([5000, 10000]);
	});

	test("stops on expired_token", async () => {
		idp.tokenReplies.push({ status: 400, body: { error: "expired_token" } });
		const endpoints = await discover(idp.issuer);
		const auth = await startDeviceAuthorization(
			endpoints,
			"mac",
			"https://tunnel.hoandat.com",
		);
		await expect(
			pollForTokens(endpoints, auth, fakeClock()),
		).rejects.toBeInstanceOf(DeviceLoginError);
	});

	test("gives up when the code's lifetime runs out while pending", async () => {
		idp.tokenReplies.push(pending);
		const endpoints = await discover(idp.issuer);
		const auth = {
			...(await startDeviceAuthorization(
				endpoints,
				"mac",
				"https://tunnel.hoandat.com",
			)),
			expiresIn: 12,
		};
		await expect(
			pollForTokens(endpoints, auth, fakeClock()),
		).rejects.toMatchObject({
			error: "expired_token",
		});
	});

	test("cleans the device name for the IdP's allowed characters", () => {
		expect(deviceNameForIdp("Alice’s MacBook <Pro>")).toBe(
			"Alices MacBook Pro",
		);
		expect(deviceNameForIdp("***")).toBe("tunelo");
		expect(deviceNameForIdp("x".repeat(100))).toHaveLength(64);
	});
});
