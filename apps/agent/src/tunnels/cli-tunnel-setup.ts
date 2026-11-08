import { configDir } from "../config.ts";
import {
	type Credential,
	NO_CREDENTIAL_MESSAGE,
	UNTRUSTED_SERVER_MESSAGE,
	resolveCredential,
} from "../identity/credentials.ts";
import { identitySession } from "../identity/session.ts";
import type { Display } from "./display.js";
import { printServerMigration, resolveServerUrl } from "./server-url.js";

export interface TunnelSetup {
	serverUrl: string;
	credential: Credential;
	/** Shown masked in the banner; only for fixed tokens. */
	displayKey?: string | undefined;
}

/** Server and credential for a tunnel command; exits when not signed in. */
export function setupTunnel(
	options: { key?: string; server?: string },
	display: Display,
): TunnelSetup {
	const serverUrl = resolveServerUrl(options.server, printServerMigration);
	const credential = resolveCredential(options.key, serverUrl);
	if (!credential) {
		const signedIn = identitySession(configDir()).info() !== undefined;
		display.showError(
			signedIn ? UNTRUSTED_SERVER_MESSAGE : NO_CREDENTIAL_MESSAGE,
		);
		process.exit(1);
	}
	return {
		serverUrl,
		credential,
		displayKey:
			credential.kind === "key"
				? (options.key ?? process.env.TUNELO_KEY)
				: undefined,
	};
}

/**
 * Account line, or the anonymous-token reminder (with the server's cutoff),
 * once the first connection is up. Feed it every tunnel event.
 */
export function credentialNotices(
	credential: Credential,
	display: Display,
): (event: { type: string; date?: string }) => void {
	let cutoff: string | undefined;
	let shown = false;
	return (event) => {
		if (event.type === "legacy-token") cutoff = event.date;
		if (event.type !== "connected" || shown) return;
		shown = true;
		if (credential.kind === "account") display.showAccount(credential.sub);
		else if (credential.anonymous) display.showLegacyReminder(cutoff);
	};
}
