import {
	SessionExpiredError,
	UntrustedServerError,
	acceptsAccountToken,
	resourceOfIssuer,
} from "@tunelo/client";
import { configDir } from "../config.ts";
import { loadSettings } from "./cli-settings.ts";
import { identitySession } from "./session.ts";

/**
 * What `tunelo http|tcp|mcp` authenticates with, in order: `--key`,
 * `TUNELO_KEY`, the account session from `tunelo login`, then an anonymous
 * token saved by an older CLI (works until the server's cutoff date).
 */
export type Credential =
	| { kind: "account"; sub: string; getKey: () => Promise<string> }
	| { kind: "key"; anonymous: boolean; getKey: () => Promise<string> };

export const UNTRUSTED_SERVER_MESSAGE =
	"Your sign-in is for another Tunelo server; run `tunelo login --server <url>` for this one, or use --key.";

/**
 * The account token for a Tunelo server, checked again on every connect:
 * never handed to a server of another domain than the session's issuer,
 * which could replay it against the real one.
 */
export function accountKeyFor(
	serverUrl: string,
	dir: string = configDir(),
): () => Promise<string> {
	return async () => {
		const session = identitySession(dir);
		const info = session.info();
		if (!info) throw new SessionExpiredError();
		if (!acceptsAccountToken(serverUrl, info.issuer)) {
			throw new UntrustedServerError(serverUrl);
		}
		return session.getAccessToken(resourceOfIssuer(info.issuer));
	};
}

export function resolveCredential(
	flagKey: string | undefined,
	serverUrl: string,
	dir: string = configDir(),
): Credential | null {
	const explicit = flagKey ?? process.env.TUNELO_KEY;
	if (explicit) {
		return {
			kind: "key",
			anonymous: explicit.startsWith("tunelo_"),
			getKey: async () => explicit,
		};
	}
	const info = identitySession(dir).info();
	if (info && acceptsAccountToken(serverUrl, info.issuer)) {
		return {
			kind: "account",
			sub: info.sub,
			getKey: accountKeyFor(serverUrl, dir),
		};
	}
	const saved = loadSettings(dir).key;
	if (saved) return { kind: "key", anonymous: true, getKey: async () => saved };
	return null;
}

export const NO_CREDENTIAL_MESSAGE =
	"Not signed in. Run `tunelo login` (or pass --key / TUNELO_KEY).";
