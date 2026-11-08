/**
 * The device sign-in of `tunelo login` as the client `tunelo-agent`: one
 * approval for the tunnel, Chat and Localman (RFC 8628, RFC 8707).
 *
 * Every request to the token endpoint carries `resource`, every poll
 * included: the grant holds three resources, so the IdP cannot pick one and
 * answers `invalid_target`, which burns the approved device code. The IdP
 * shows no link with the code filled in for this client: the person types
 * the code.
 */
import {
	type DeviceAuthorization,
	type IdpEndpoints,
	type TokenSet,
	pollForTokens,
	startDeviceAuthorization,
} from "@tunelo/client";
import { AGENT_CLIENT_ID, AGENT_SCOPE, type AppName, appResources } from "./session.ts";

/** RFC 8628: poll every 5 s when the IdP names no interval. */
const DEFAULT_INTERVAL_S = 5;

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

export interface AgentPollOptions {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Polls until the person approves (RFC 8628 §3.5, as `pollForTokens` does)
 * and resolves with the tokens of `app`: an access token for its resource.
 */
export function pollAgentTokens(
	endpoints: IdpEndpoints,
	issuer: string,
	authorization: DeviceAuthorization,
	app: AppName,
	options: AgentPollOptions = {},
): Promise<TokenSet> {
	const interval = authorization.interval > 0 ? authorization.interval : DEFAULT_INTERVAL_S;
	return pollForTokens(endpoints, { ...authorization, interval }, {
		clientId: AGENT_CLIENT_ID,
		resource: appResources(issuer)[app],
		...(options.sleep ? { sleep: options.sleep } : {}),
		...(options.now ? { now: options.now } : {}),
	});
}
