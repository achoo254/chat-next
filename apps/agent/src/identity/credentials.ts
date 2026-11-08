import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { acceptsAccountToken } from "@tunelo/client";
import { loadConfig, updateConfig } from "./config.js";
import { getAccessToken } from "./idp-session.js";

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

export function resolveCredential(
	flagKey: string | undefined,
	serverUrl: string,
): Credential | null {
	const explicit = flagKey ?? process.env.TUNELO_KEY;
	if (explicit) {
		return {
			kind: "key",
			anonymous: explicit.startsWith("tunelo_"),
			getKey: async () => explicit,
		};
	}
	const config = loadConfig();
	if (config.session && acceptsAccountToken(serverUrl, config.session.issuer)) {
		return {
			kind: "account",
			sub: config.session.sub,
			getKey: () => getAccessToken(),
		};
	}
	const saved = config.key;
	if (saved) return { kind: "key", anonymous: true, getKey: async () => saved };
	return null;
}

/** Stable per-machine id; created once and persisted in the config. */
export function getDeviceId(): string {
	const existing = loadConfig().deviceId;
	if (existing) return existing;
	const deviceId = randomUUID();
	updateConfig((config) => ({ ...config, deviceId }));
	return deviceId;
}

/** Machine details sent with `auth` so the account can tell machines apart. */
export function deviceInfo(): { deviceId: string; deviceName: string } {
	return { deviceId: getDeviceId(), deviceName: hostname().slice(0, 80) };
}

export const NO_CREDENTIAL_MESSAGE =
	"Not signed in. Run `tunelo login` (or pass --key / TUNELO_KEY).";
