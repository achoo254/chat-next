import { getApiBaseUrl, verifyKey } from "./api-client.js";
import { configDir } from "../config.ts";
import { resolveCredential } from "../identity/credentials.ts";
import { legacyReminder } from "./display.js";

export type WhoAmI =
	| { kind: "account"; account: string }
	| { kind: "anonymous"; valid: boolean; legacyTokenCutoff?: string | undefined }
	| { kind: "none" };

/** Who this machine tunnels as. Anonymous tokens are checked with the server. */
export async function whoAmI(
	serverUrl: string,
	dir: string = configDir(),
): Promise<WhoAmI> {
	const credential = resolveCredential(undefined, serverUrl, dir);
	if (!credential) return { kind: "none" };
	if (credential.kind === "account") {
		return { kind: "account", account: credential.sub };
	}
	const result = await verifyKey(
		getApiBaseUrl(serverUrl),
		await credential.getKey(),
	);
	return {
		kind: "anonymous",
		valid: result.valid,
		legacyTokenCutoff: result.legacyTokenCutoff,
	};
}

export function describeWhoAmI(who: WhoAmI): string {
	switch (who.kind) {
		case "account":
			return `Signed in with account ${who.account}.`;
		case "anonymous":
			return who.valid
				? legacyReminder(who.legacyTokenCutoff)
				: "Anonymous token, no longer accepted. Run `tunelo login`.";
		case "none":
			return "Not signed in. Run `tunelo login`.";
	}
}
