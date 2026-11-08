import type { TunnelClient, TunnelClientOptions } from "@tunelo/client";
import { loadConfig } from "./config.js";
import {
	type Credential,
	NO_CREDENTIAL_MESSAGE,
	UNTRUSTED_SERVER_MESSAGE,
	deviceInfo,
	resolveCredential,
} from "./credentials.js";
import type { Display } from "./display.js";
import { printServerMigration, resolveServerUrl } from "./server-url.js";

export interface TunnelSetup {
	serverUrl: string;
	credential: Credential;
	/** Connection options shared by `tunelo http` and `tunelo tcp`. */
	clientOptions: Pick<
		TunnelClientOptions,
		"serverUrl" | "getApiKey" | "deviceId" | "deviceName"
	>;
	/** Shown masked in the banner; only for fixed tokens. */
	displayKey?: string;
}

/** Server and credential for a tunnel command; exits when not signed in. */
export function setupTunnel(
	options: { key?: string; server?: string },
	display: Display,
): TunnelSetup {
	const serverUrl = resolveServerUrl(options.server, printServerMigration);
	const credential = resolveCredential(options.key, serverUrl);
	if (!credential) {
		const signedIn = loadConfig().session !== undefined;
		display.showError(
			signedIn ? UNTRUSTED_SERVER_MESSAGE : NO_CREDENTIAL_MESSAGE,
		);
		process.exit(1);
	}
	return {
		serverUrl,
		credential,
		clientOptions: {
			serverUrl,
			getApiKey: credential.getKey,
			...deviceInfo(),
		},
		displayKey:
			credential.kind === "key"
				? (options.key ?? process.env.TUNELO_KEY)
				: undefined,
	};
}

/** Account line, or the anonymous-token reminder (with the server's cutoff). */
export function showCredentialNotices(
	client: TunnelClient,
	credential: Credential,
	display: Display,
): void {
	let cutoff: string | undefined;
	client.on("legacy-token", (date: string) => {
		cutoff = date;
	});
	client.once("connected", () => {
		if (credential.kind === "account") display.showAccount(credential.sub);
		else if (credential.anonymous) display.showLegacyReminder(cutoff);
	});
}
