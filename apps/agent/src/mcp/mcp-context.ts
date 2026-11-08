import type { TunnelClientOptions } from "@tunelo/client";
import {
	type Credential,
	NO_CREDENTIAL_MESSAGE,
	deviceInfo,
	resolveCredential,
} from "../credentials.js";

/** What the MCP tools need from the CLI, resolved per call so a
 *  `tunelo login` done while the server runs is picked up. */
export interface McpContext {
	serverUrl: string;
	credential(): Credential | null;
	clientOptions(): Pick<
		TunnelClientOptions,
		"serverUrl" | "getApiKey" | "deviceId" | "deviceName"
	>;
	/** Diagnostics go to stderr: stdout carries the MCP protocol. */
	log(message: string): void;
}

export function createMcpContext(serverUrl: string): McpContext {
	return {
		serverUrl,
		credential: () => resolveCredential(undefined, serverUrl),
		clientOptions() {
			const credential = resolveCredential(undefined, serverUrl);
			if (!credential) throw new Error(NO_CREDENTIAL_MESSAGE);
			return { serverUrl, getApiKey: credential.getKey, ...deviceInfo() };
		},
		log: (message) => process.stderr.write(`[tunelo mcp] ${message}\n`),
	};
}
