import { describe, expect, it } from "vitest";
import {
	authorizationUrl,
	callbackCode,
	isCancelled,
	NativeSignInError,
	parseAuthConfig,
	pkcePair,
	redirectScheme,
	safeReturnTo,
	signInNative,
	type AuthConfig,
	type SignInDeps,
} from "../src/native/native-sign-in.ts";

const REDIRECT = "com.hoandat.chat:/auth/callback";
const CONFIG: AuthConfig = {
	clientId: "chat-mobile",
	authorizationEndpoint: "https://auth.example/authorize",
	redirectUri: REDIRECT,
	scopes: ["openid", "profile", "email"],
};

/** Deterministic "random" bytes. */
const counting = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, i) => i);

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

/** A server that answers GetAuthConfig and ExchangeNativeCode like chat's. */
function fakeServer(exchange: (body: Record<string, unknown>) => Response = () => json(200, { sessionToken: "tok-1", sessionId: "5" })) {
	const calls: Call[] = [];
	const rpcFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url, body });
		if (url.endsWith("/rpc/app.v1.AuthService/GetAuthConfig")) return json(200, { ...CONFIG, issuer: "https://auth.example" });
		if (url.endsWith("/rpc/app.v1.AuthService/ExchangeNativeCode")) return exchange(body);
		return json(404, { code: "unimplemented", message: "no" });
	};
	return { calls, rpcFetch };
}

function deps(rpcFetch: typeof fetch, authenticate: SignInDeps["authenticate"], saved: string[]): SignInDeps {
	return {
		rpcFetch,
		authenticate,
		saveToken: async (token) => {
			saved.push(token);
		},
		platform: "android",
		deviceName: "Android",
		appVersion: "1.0.0",
		random: counting,
	};
}

/** A system browser that signs in at once and comes back with the request's state. */
const signsIn = (code = "the-code") => async (url: string, scheme: string) => {
	expect(scheme).toBe("com.hoandat.chat");
	const state = new URL(url).searchParams.get("state") ?? "";
	return `${REDIRECT}?code=${code}&state=${state}`;
};

describe("native sign-in", () => {
	it("makes an RFC 7636 verifier and its S256 challenge", async () => {
		const { verifier, challenge } = await pkcePair(counting);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
		const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(challenge).toBe(expected);
	});

	it("builds the authorization request the IdP expects", () => {
		const url = new URL(authorizationUrl(CONFIG, { locale: "vi", create: false, reauth: false }, "st", "ch"));
		expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "chat-mobile",
			redirect_uri: REDIRECT,
			response_type: "code",
			scope: "openid profile email",
			state: "st",
			code_challenge: "ch",
			code_challenge_method: "S256",
			ui_locales: "vi",
		});
		const create = new URL(authorizationUrl(CONFIG, { locale: "en", create: true, reauth: false }, "s", "c")).searchParams;
		expect(create.get("prompt")).toBe("create");
		const reauth = new URL(authorizationUrl(CONFIG, { locale: "x!", create: true, reauth: true }, "s", "c")).searchParams;
		expect([reauth.get("prompt"), reauth.get("max_age"), reauth.get("ui_locales")]).toEqual(["login", "600", null]);
	});

	it("accepts only a callback of this sign-in", () => {
		expect(callbackCode(`${REDIRECT}?code=abc&state=st`, REDIRECT, "st")).toBe("abc");
		const bad = [
			`${REDIRECT}?code=abc&state=other`,
			`${REDIRECT}?code=abc`,
			`com.evil.app:/auth/callback?code=abc&state=st`,
			`com.hoandat.chat:/other?code=abc&state=st`,
			`${REDIRECT}?error=access_denied&state=st`,
			`${REDIRECT}?state=st`,
			"not a url",
		];
		for (const url of bad) expect(() => callbackCode(url, REDIRECT, "st"), url).toThrow(NativeSignInError);
	});

	it("reads the IdP parameters and refuses incomplete ones", () => {
		expect(parseAuthConfig({ ...CONFIG, tenantName: "example" })).toEqual(CONFIG);
		expect(redirectScheme(REDIRECT)).toBe("com.hoandat.chat");
		expect(() => parseAuthConfig({ ...CONFIG, redirectUri: "" })).toThrow(NativeSignInError);
		expect(() => parseAuthConfig({ ...CONFIG, authorizationEndpoint: "http://auth.example/authorize" })).toThrow(NativeSignInError);
		expect(() => parseAuthConfig(null)).toThrow(NativeSignInError);
	});

	it("exchanges the code with its verifier and stores the session token", async () => {
		const server = fakeServer();
		const saved: string[] = [];
		let opened = "";
		const done = await signInNative(
			deps(server.rpcFetch, async (url, scheme) => {
				opened = url;
				return signsIn()(url, scheme);
			}, saved),
			{ locale: "vi", create: false, reauth: false },
		);
		expect(done).toBe(true);
		expect(saved).toEqual(["tok-1"]);
		expect(server.calls[0]?.body).toEqual({ platform: "CLIENT_PLATFORM_ANDROID" });
		const exchange = server.calls[1]?.body ?? {};
		const { challenge } = await pkcePair(counting);
		expect(new URL(opened).searchParams.get("code_challenge")).toBe(challenge);
		expect(exchange).toEqual({
			code: "the-code",
			codeVerifier: (await pkcePair(counting)).verifier,
			redirectUri: REDIRECT,
			platform: "CLIENT_PLATFORM_ANDROID",
			deviceName: "Android",
			appVersion: "1.0.0",
		});
	});

	it("ends quietly when the user closes the browser", async () => {
		const server = fakeServer();
		const saved: string[] = [];
		const cancelled = Object.assign(new Error("closed"), { code: "CANCELLED" });
		expect(isCancelled(cancelled)).toBe(true);
		await expect(signInNative(deps(server.rpcFetch, () => Promise.reject(cancelled), saved), { locale: "vi", create: false, reauth: false })).resolves.toBe(false);
		expect(saved).toEqual([]);
		expect(server.calls).toHaveLength(1);
	});

	it("reports why a sign-in failed", async () => {
		const cases: [Response, string][] = [
			[json(400, { code: "invalid_argument", message: "sign_in_failed" }), "failed"],
			[json(429, { code: "resource_exhausted", message: "signup_limited" }), "limited"],
			[json(503, { code: "unavailable", message: "down" }), "unavailable"],
			[json(200, {}), "unavailable"],
		];
		for (const [answer, kind] of cases) {
			const server = fakeServer(() => answer.clone());
			const err = await signInNative(deps(server.rpcFetch, signsIn(), []), { locale: "vi", create: false, reauth: false }).catch((e: unknown) => e);
			expect(err, kind).toBeInstanceOf(NativeSignInError);
			expect((err as NativeSignInError).kind).toBe(kind);
		}
		const plugin = Object.assign(new Error("no browser"), { code: "FAILED" });
		const err = await signInNative(deps(fakeServer().rpcFetch, () => Promise.reject(plugin), []), { locale: "vi", create: false, reauth: false }).catch((e: unknown) => e);
		expect((err as NativeSignInError).kind).toBe("failed");
	});

	it("returns only to a path of this app after signing in", () => {
		const origin = "capacitor://localhost";
		expect(safeReturnTo("/settings/account?after=delete", origin)).toBe("/settings/account?after=delete");
		expect(safeReturnTo("/console/bot/7#tokens", "https://localhost")).toBe("/console/bot/7#tokens");
		const bad = [
			null,
			"",
			"settings",
			"//evil.com",
			"/\\evil.com",
			"/\\/evil.com",
			"\\evil.com",
			"https://evil.com/",
			"/ok\nnext",
			"/ok\u0000",
			"/a b",
			"/auth/login?reauth=1",
			"/AUTH/callback",
			"/auth",
			`/${"a".repeat(600)}`,
		];
		for (const raw of bad) expect(safeReturnTo(raw, origin), String(raw)).toBe("/");
	});
});
