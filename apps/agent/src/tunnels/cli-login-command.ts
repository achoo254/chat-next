import { hostname } from "node:os";
import {
	IDP_DEFAULTS,
	deviceNameForIdp,
	discover,
	serverIdentity,
} from "@tunelo/client";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { pollAgentTokens, startAgentAuthorization } from "../identity/agent-login.ts";
import { updateSettings } from "../identity/cli-settings.ts";
import { AGENT_CLIENT_ID, appResources, identitySession } from "../identity/session.ts";
import { getApiBaseUrl, verifyKey } from "./api-client.js";
import { openBrowser } from "./open-browser.js";
import { printServerMigration, resolveServerUrl } from "./server-url.js";

/** `--server` as an origin; anything but an http(s) URL is refused. */
function normalizeServer(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		fail("--server must be a URL such as https://tunnel.example.com");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		fail("--server must use https");
	}
	return url.origin;
}

function fail(message: string): never {
	console.error(`  ${message}`);
	process.exit(1);
}

/** `--legacy-key`: CI without a browser keeps using an anonymous token. */
async function saveLegacyKey(key: string): Promise<void> {
	const baseUrl = getApiBaseUrl(
		resolveServerUrl(undefined, printServerMigration),
	);
	const result = await verifyKey(baseUrl, key).catch((err: Error) =>
		fail(`Could not reach the server: ${err.message}`),
	);
	if (!result.valid || result.kind !== "legacy") {
		fail("That token is not a valid anonymous access token.");
	}
	updateSettings((settings) => ({ ...settings, key }));
	console.log("  ✓ Token verified & saved. Run: tunelo http <port>");
}

/**
 * The IdP that signs in for `serverUrl`, from its host (`tunnel.<d>` →
 * `https://auth.<d>`); `TUNELO_AUTH_ISSUER` points tunelo at a staging or
 * local IdP instead.
 */
function issuerFor(serverUrl: string): string {
	return (
		process.env.TUNELO_AUTH_ISSUER ??
		serverIdentity(serverUrl)?.issuer ??
		IDP_DEFAULTS.issuer
	).replace(/\/+$/, "");
}

/**
 * Device sign-in at `issuer` as `tunelo-agent`, for the tunnel, Chat and
 * Localman at once. The current session (an older `tunelo-cli` one
 * included) stays in use until the new one is saved, and its grant is
 * revoked only then: a failed or abandoned sign-in leaves it working.
 * Rejects with the reason; the caller decides how to end.
 */
async function deviceLogin(issuer: string): Promise<string> {
	const endpoints = await discover(issuer).catch((err: Error) => {
		throw new Error(`Could not reach ${issuer}: ${err.message}`);
	});
	const authorization = await startAgentAuthorization(
		endpoints,
		issuer,
		deviceNameForIdp(hostname()),
	);

	// The IdP gives this client no link with the code filled in: the person
	// types the code shown here, on a page they opened themselves.
	console.log();
	console.log("  Sign in with your account in the browser (Tunelo, Chat and Localman):");
	console.log(`  ${authorization.verificationUri}`);
	console.log(`  and type the code: ${authorization.userCode}`);
	console.log();
	console.log("  Waiting for approval...");
	await openBrowser(authorization.verificationUri);

	const tokens = await pollAgentTokens(endpoints, issuer, authorization, "tunnel");
	const resources = appResources(issuer);
	const { info, revokeError } = await identitySession(configDir()).replace(
		issuer,
		tokens,
		resources.tunnel,
		AGENT_CLIENT_ID,
		Object.values(resources),
	);
	if (revokeError) {
		console.error(
			`  Could not revoke the previous sign-in at ${issuer} (${revokeError.message}); revoke it at ${issuer}/account.`,
		);
	}
	return info.sub;
}

/**
 * Signs this machine in for `serverUrl` unless it already is (or `force`).
 * Resolves with the account id, and whether a sign-in happened now; rejects
 * when the sign-in fails (the stored session is then unchanged).
 */
export async function signInForServer(
	serverUrl: string,
	force = false,
): Promise<{ sub: string; signedInNow: boolean }> {
	const issuer = issuerFor(serverUrl);
	const session = identitySession(configDir());
	const existing = session.info();
	// Another IdP: its session replaces this one (one session). A stored
	// session that no longer opens, or one of the tunnel-only client of
	// older installs, is signed in again without --force.
	if (
		existing?.issuer === issuer &&
		existing.clientId === AGENT_CLIENT_ID &&
		!force &&
		(await session.isUsable())
	) {
		console.log(
			`  Already signed in (account ${existing.sub}). Use --force to sign in again.`,
		);
		return { sub: existing.sub, signedInNow: false };
	}
	const sub = await deviceLogin(issuer);
	// A running service adds or claims the machine in Chat now instead of at its next try.
	await callControl(configDir(), "POST", "/registration/retry").catch(() => undefined);
	return { sub, signedInNow: true };
}

export function registerLoginCommands(program: Command): void {
	program
		.command("login")
		.description("Sign in with your account for the tunnel, Chat and Localman (opens the browser)")
		.option(
			"--legacy-key [token]",
			"Save an anonymous access token instead (CI, no browser); without a value it is read from TUNELO_KEY, keeping it out of shell history",
		)
		.option("-f, --force", "Sign in again even if already signed in")
		.option(
			"-s, --server <url>",
			"Tunelo server to sign in for (https://tunnel.<domain>); it becomes the default server",
		)
		.action(
			async (options: {
				legacyKey?: string | boolean;
				force?: boolean;
				server?: string;
			}) => {
				if (options.legacyKey !== undefined) {
					const key =
						typeof options.legacyKey === "string"
							? options.legacyKey
							: process.env.TUNELO_KEY;
					if (!key) fail("Pass the token or set TUNELO_KEY.");
					await saveLegacyKey(key);
					return;
				}
				const serverUrl = options.server
					? normalizeServer(options.server)
					: resolveServerUrl(undefined, printServerMigration);
				const { sub, signedInNow } = await signInForServer(
					serverUrl,
					options.force === true,
				).catch((err: Error) => fail(err.message));
				if (options.server) {
					updateSettings((settings) => ({ ...settings, server: serverUrl }));
				}
				if (signedInNow) {
					console.log(
						`  ✓ Signed in (account ${sub}). Run: tunelo http <port>`,
					);
				}
			},
		);

	program
		.command("logout")
		.description("Sign out: revoke this machine's sign-in and forget tokens")
		.action(async () => {
			const dir = configDir();
			const result = await identitySession(dir).signOut();
			let hadKey = false;
			updateSettings((settings) => {
				hadKey = settings.key !== undefined;
				// Keep deviceId so a later sign-in stays idempotent for this machine.
				return { ...settings, key: undefined };
			});
			if (!result && !hadKey) {
				console.log("  Not signed in.");
				return;
			}
			if (result?.revokeError) {
				console.error(
					`  Could not revoke at ${result.issuer} (${result.revokeError.message}); revoke this machine at ${result.issuer}/account.`,
				);
			}
			console.log("  Signed out. Tokens removed from this machine.");
		});
}
