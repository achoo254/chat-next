/**
 * The device sign-in of `tunelo login` as the client `tunelo-agent`: one
 * approval for the tunnel, Chat and Localman (RFC 8628, RFC 8707).
 *
 * Every request to the token endpoint carries `resource`, every poll
 * included: the grant holds three resources, so the IdP cannot pick one and
 * answers `invalid_target`, which burns the approved device code. The poll of
 * `@tunelo/client` sends none, hence this one. The IdP shows no link with the
 * code filled in for this client: the person types the code.
 */
import {
	DEVICE_CODE_GRANT,
	type DeviceAuthorization,
	DeviceLoginError,
	type IdpEndpoints,
	OAuthResponseError,
	type TokenSet,
	startDeviceAuthorization,
} from "@tunelo/client";
import { AGENT_CLIENT_ID, AGENT_SCOPE, type AppName, appResources } from "./session.ts";

const HTTP_TIMEOUT_MS = 10_000;
const SLOW_DOWN_STEP_S = 5;
const MAX_NETWORK_FAILURES = 3;

/** Starts the sign-in for every app of `issuer`. */
export function startAgentAuthorization(
	endpoints: IdpEndpoints,
	issuer: string,
	deviceName: string,
): Promise<DeviceAuthorization> {
	return startDeviceAuthorization(endpoints, deviceName, Object.values(appResources(issuer)), {
		clientId: AGENT_CLIENT_ID,
		scope: AGENT_SCOPE,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** One poll of the token endpoint: the tokens, or its OAuth error. */
async function exchange(endpoints: IdpEndpoints, deviceCode: string, resource: string): Promise<TokenSet> {
	const res = await fetch(endpoints.token, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams({
			grant_type: DEVICE_CODE_GRANT,
			device_code: deviceCode,
			client_id: AGENT_CLIENT_ID,
			resource,
		}).toString(),
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
	const text = await res.text();
	let body: unknown;
	try {
		body = text.trim() === "" ? {} : JSON.parse(text);
	} catch {
		throw new Error(`Identity provider answered HTTP ${res.status}, not JSON`);
	}
	if (!isRecord(body)) throw new Error(`Token endpoint answered HTTP ${res.status}`);
	if (res.status >= 400 || body.error) {
		throw new OAuthResponseError(str(body.error) ?? "server_error", res.status);
	}
	const accessToken = str(body.access_token);
	if (!accessToken) throw new Error("Token response has no access_token");
	return {
		accessToken,
		refreshToken: str(body.refresh_token),
		idToken: str(body.id_token),
		expiresIn: typeof body.expires_in === "number" ? body.expires_in : 300,
	};
}

export interface AgentPollOptions {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Polls until the person approves, as RFC 8628 §3.5 says:
 * `authorization_pending` waits, `slow_down` (and a 429) adds 5 s, network
 * trouble doubles the interval, anything else ends the sign-in. Resolves with
 * the tokens of `app` (an access token for its resource).
 */
export async function pollAgentTokens(
	endpoints: IdpEndpoints,
	issuer: string,
	authorization: DeviceAuthorization,
	app: AppName,
	options: AgentPollOptions = {},
): Promise<TokenSet> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = options.now ?? Date.now;
	const resource = appResources(issuer)[app];
	const deadline = now() + authorization.expiresIn * 1000;
	// RFC 8628: 5 s when the IdP names no interval.
	let interval = authorization.interval > 0 ? authorization.interval : 5;
	let networkFailures = 0;
	while (now() < deadline) {
		await sleep(interval * 1000);
		try {
			return await exchange(endpoints, authorization.deviceCode, resource);
		} catch (err) {
			if (!(err instanceof OAuthResponseError) || err.status >= 500) {
				if (++networkFailures > MAX_NETWORK_FAILURES) throw err;
				interval *= 2;
				continue;
			}
			networkFailures = 0;
			if (err.error === "authorization_pending") continue;
			if (err.error === "slow_down" || err.status === 429) {
				interval += SLOW_DOWN_STEP_S;
				continue;
			}
			throw new DeviceLoginError(err.error);
		}
	}
	throw new DeviceLoginError("expired_token");
}
