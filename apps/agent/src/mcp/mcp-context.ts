import type { TunnelClientOptions } from "@tunelo/client";
import { deviceInfo } from "../identity/cli-settings.ts";
import {
	type Credential,
	NO_CREDENTIAL_MESSAGE,
	resolveCredential,
} from "../identity/credentials.ts";

/** What the MCP tools need from tunelo, resolved per call so a
 *  `tunelo login` done while the service runs is picked up. */
export interface McpContext {
	serverUrl: string;
	/** tunelo's config folder (settings, session). */
	dir: string;
	credential(): Credential | null;
	clientOptions(): Pick<
		TunnelClientOptions,
		"serverUrl" | "getApiKey" | "deviceId" | "deviceName"
	>;
	/** Diagnostics go to stderr: stdout carries the MCP protocol. */
	log(message: string): void;
}

export function createMcpContext(serverUrl: string, dir: string): McpContext {
	return {
		serverUrl,
		dir,
		credential: () => resolveCredential(undefined, serverUrl, dir),
		clientOptions() {
			const credential = resolveCredential(undefined, serverUrl, dir);
			if (!credential) throw new Error(NO_CREDENTIAL_MESSAGE);
			return { serverUrl, getApiKey: credential.getKey, ...deviceInfo(dir) };
		},
		log: (message) => process.stderr.write(`[tunelo mcp] ${message}\n`),
	};
}
