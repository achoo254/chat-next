// Native sign-in (ADR 0006): Code + PKCE with the IdP's public chat-mobile
// client in the system browser, never in the WebView. The app asks the
// server for the tenant's IdP parameters (GetAuthConfig), opens the
// authorization URL through the shared system-auth plugin, checks the state
// of the callback and hands the code and verifier to ExchangeNativeCode,
// which answers with the chat session token. The IdP tokens stay on the
// server.
import { isReturnPath } from "@app/core";
import { Code } from "@connectrpc/connect";
import { callJson, RPC_BASE_URL, RpcError } from "../api/get-self.ts";
import type { RpcFetch } from "../api/client.ts";

export type NativePlatform = "ios" | "android";

/** What the sign-in link asked for (the /auth/login query of the web). */
export interface SignInRequest {
	readonly locale: string;
	/** Opens the IdP's sign-up page (prompt=create). */
	readonly create: boolean;
	/** Asks the IdP for the credentials again (prompt=login, max_age), for actions that need a recent sign-in. */
	readonly reauth: boolean;
}

export interface SignInDeps {
	/** Calls the server; sends the current bearer token, so signing in again replaces this device's session. */
	readonly rpcFetch: RpcFetch;
	/** Opens `url` in the system browser and resolves with the callback URL (SystemAuth.authenticate). */
	readonly authenticate: (url: string, scheme: string) => Promise<string>;
	readonly saveToken: (token: string) => Promise<void>;
	readonly platform: NativePlatform;
	readonly deviceName: string;
	readonly appVersion: string;
	/** `length` random bytes; crypto.getRandomValues by default. */
	readonly random?: (length: number) => Uint8Array<ArrayBuffer>;
}

export type SignInFailure = "failed" | "unavailable" | "limited";

/** A sign-in that did not finish for a reason other than the user closing the browser. */
export class NativeSignInError extends Error {
	readonly kind: SignInFailure;

	constructor(kind: SignInFailure, message: string) {
		super(message);
		this.name = "NativeSignInError";
		this.kind = kind;
	}
}

/** max_age of a reauthentication; the server checks auth_time against the same window. */
const REAUTH_MAX_AGE_SECONDS = 600;

const WIRE_PLATFORM: Record<NativePlatform, string> = {
	ios: "CLIENT_PLATFORM_IOS",
	android: "CLIENT_PLATFORM_ANDROID",
};

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier (RFC 7636 §4.1: 43 unreserved characters from 32 random bytes) and its S256 challenge. */
export async function pkcePair(random: (length: number) => Uint8Array<ArrayBuffer>): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(random(32));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface AuthConfig {
	readonly clientId: string;
	readonly authorizationEndpoint: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

/** Reads GetAuthConfigResponse (proto3 JSON); a field the flow needs that is missing fails the sign-in. */
export function parseAuthConfig(body: unknown): AuthConfig {
	if (!isRecord(body)) throw new NativeSignInError("unavailable", "GetAuthConfig: no answer");
	const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
	const config = {
		clientId: text(body, "clientId"),
		authorizationEndpoint: text(body, "authorizationEndpoint"),
		redirectUri: text(body, "redirectUri"),
		scopes,
	};
	if (config.clientId === "" || config.redirectUri === "" || !config.authorizationEndpoint.startsWith("https://")) {
		throw new NativeSignInError("unavailable", "GetAuthConfig: incomplete IdP parameters");
	}
	return config;
}

/** The scheme of a private-use redirect URI, e.g. com.hoandat.chat of com.hoandat.chat:/auth/callback. */
export function redirectScheme(redirectUri: string): string {
	const colon = redirectUri.indexOf(":");
	if (colon <= 0) throw new NativeSignInError("unavailable", "GetAuthConfig: invalid redirect URI");
	return redirectUri.slice(0, colon);
}

/** The authorization request (Code + PKCE S256), as the web's server builds it for /auth/login. */
export function authorizationUrl(config: AuthConfig, request: SignInRequest, state: string, challenge: string): string {
	const url = new URL(config.authorizationEndpoint);
	const q = url.searchParams;
	q.set("client_id", config.clientId);
	q.set("redirect_uri", config.redirectUri);
	q.set("response_type", "code");
	q.set("scope", config.scopes.join(" "));
	q.set("state", state);
	q.set("code_challenge", challenge);
	q.set("code_challenge_method", "S256");
	if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(request.locale)) q.set("ui_locales", request.locale);
	if (request.reauth) {
		q.set("prompt", "login");
		q.set("max_age", String(REAUTH_MAX_AGE_SECONDS));
	} else if (request.create) {
		q.set("prompt", "create");
	}
	return url.toString();
}

/**
 * The code of the callback URL. Only a callback of this sign-in counts: its
 * redirect URI and state must match (a URL another app or page opened with
 * the scheme is rejected).
 */
export function callbackCode(callbackUrl: string, redirectUri: string, state: string): string {
	let url: URL;
	try {
		url = new URL(callbackUrl);
	} catch {
		throw new NativeSignInError("failed", "callback: not a URL");
	}
	const expected = new URL(redirectUri);
	if (url.protocol !== expected.protocol || url.pathname !== expected.pathname) {
		throw new NativeSignInError("failed", "callback: another redirect URI");
	}
	if (url.searchParams.get("state") !== state) throw new NativeSignInError("failed", "callback: state mismatch");
	const error = url.searchParams.get("error");
	if (error !== null) throw new NativeSignInError("failed", `IdP answered ${error.slice(0, 64)}`);
	const code = url.searchParams.get("code") ?? "";
	if (code === "") throw new NativeSignInError("failed", "callback: no code");
	return code;
}

function failureOf(err: unknown): NativeSignInError {
	if (err instanceof NativeSignInError) return err;
	if (err instanceof RpcError) {
		if (err.code === Code.ResourceExhausted) return new NativeSignInError("limited", err.message);
		if (err.code === Code.InvalidArgument) return new NativeSignInError("failed", err.message);
		return new NativeSignInError("unavailable", err.message);
	}
	return new NativeSignInError("unavailable", err instanceof Error ? err.message : String(err));
}

/**
 * Where to go after signing in: return_to when it is a path of this app
 * (the rules of the server's CleanReturnTo: one leading "/", no backslash,
 * whitespace or control character, not under /auth/) that also resolves to
 * this origin; "/" otherwise.
 */
export function safeReturnTo(raw: string | null, origin: string): string {
	if (raw === null || !isReturnPath(raw)) return "/";
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return "/";
	}
	return url.origin === new URL(origin).origin ? raw : "/";
}

/** Whether the system-auth plugin reported that the user closed the browser. */
export function isCancelled(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "CANCELLED";
}

/**
 * Runs the whole sign-in and stores the new session token. Resolves false
 * when the user closed the browser; rejects with NativeSignInError otherwise.
 */
export async function signInNative(deps: SignInDeps, request: SignInRequest): Promise<boolean> {
	const random = deps.random ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
	try {
		const config = parseAuthConfig(
			await callJson(deps.rpcFetch, `${RPC_BASE_URL}/app.v1.AuthService/GetAuthConfig`, JSON.stringify({ platform: WIRE_PLATFORM[deps.platform] })),
		);
		const { verifier, challenge } = await pkcePair(random);
		const state = base64Url(random(32));
		let callback: string;
		try {
			callback = await deps.authenticate(authorizationUrl(config, request, state, challenge), redirectScheme(config.redirectUri));
		} catch (err) {
			if (isCancelled(err)) return false;
			throw new NativeSignInError("failed", err instanceof Error ? err.message : String(err));
		}
		const code = callbackCode(callback, config.redirectUri, state);
		const answer = await callJson(
			deps.rpcFetch,
			`${RPC_BASE_URL}/app.v1.AuthService/ExchangeNativeCode`,
			JSON.stringify({
				code,
				codeVerifier: verifier,
				redirectUri: config.redirectUri,
				platform: WIRE_PLATFORM[deps.platform],
				deviceName: deps.deviceName,
				appVersion: deps.appVersion,
			}),
		);
		const token = isRecord(answer) ? text(answer, "sessionToken") : "";
		if (token === "") throw new NativeSignInError("unavailable", "ExchangeNativeCode returned no session");
		await deps.saveToken(token);
		return true;
	} catch (err) {
		throw failureOf(err);
	}
}

/** Ends the session on the server (SignOut, which also revokes its IdP grant); best effort. */
export async function signOutNative(rpcFetch: RpcFetch): Promise<void> {
	try {
		await callJson(rpcFetch, `${RPC_BASE_URL}/app.v1.AuthService/SignOut`, "{}");
	} catch (err) {
		// Offline or already revoked: the token is forgotten anyway.
		console.warn("sign-out:", err instanceof Error ? err.message : String(err));
	}
}
