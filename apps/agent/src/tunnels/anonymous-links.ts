/**
 * Whether this machine's tunnels have links of their own: a machine on an
 * anonymous token (no account for this server) may still hold links that
 * Localman got before linking by code was retired. They stay usable until
 * revoked; the MCP tools list and revoke them (mcp/link-tools.ts). A
 * signed-in machine shares its tunnels through the account instead.
 */
import { configDir } from "../config.ts";
import { loadSettings } from "../identity/cli-settings.ts";
import { accountServes } from "../identity/credentials.ts";
import { identitySession } from "../identity/session.ts";

export const LINKS_NOT_NEEDED_MESSAGE =
	"Not needed: you are signed in, so Localman sees this machine's tunnels through your account.";
export const OTHER_SERVER_SESSION_MESSAGE =
	"Your sign-in is for another Tunelo server, so this machine's tunnels use its anonymous token. Run `tunelo login` to use your account here.";

export const NO_ANONYMOUS_TOKEN_MESSAGE =
	"No anonymous token on this machine. Run `tunelo login`.";

/** What decides whether this machine needs links: its sign-in and anonymous token. */
export interface LinkState {
	/** Issuer of the account session, if signed in. */
	issuer?: string | undefined;
	key?: string | undefined;
}

export function linkStateOf(dir: string = configDir()): LinkState {
	return {
		issuer: identitySession(dir).info()?.issuer,
		key: loadSettings(dir).key,
	};
}

export type LinkContext =
	| { kind: "not-needed" }
	| { kind: "no-key" }
	| { kind: "anonymous"; key: string; otherServerSession: boolean };

/**
 * Same rule as `tunelo http` (`resolveCredential`): a sign-in only counts
 * when its token may go to this server. A session of another server (e.g.
 * from before a domain move) leaves the tunnels on the anonymous token, so
 * the machine still needs a link.
 */
export function linkContextOf(
	state: LinkState,
	serverUrl: string,
	envKey: string | undefined,
): LinkContext {
	const issuer = state.issuer;
	if (issuer && accountServes(serverUrl, issuer)) {
		return { kind: "not-needed" };
	}
	const key = envKey ?? state.key;
	if (!key) return { kind: "no-key" };
	return { kind: "anonymous", key, otherServerSession: Boolean(issuer) };
}
