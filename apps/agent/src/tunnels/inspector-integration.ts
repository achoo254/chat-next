/** Wires up inspector server with request store + replay capabilities */

import { startInspectorServer } from "./inspector-server.js";
import { proxyRequest } from "./local-proxy.js";
import type { InspectorEntry } from "./request-store.js";
import { RequestStore } from "./request-store.js";

interface InspectorIntegrationOptions {
	/** Preferred inspector port — the next free one is used when it is taken */
	inspectPort: number;
	/** Subdomain→port map (mutated externally as tunnels register) */
	subdomainPortMap: Map<string, number>;
	/** Public URL of each subdomain, as the server reported it. */
	tunnelUrls: Map<string, string>;
	/** Fallback local port for replay */
	defaultPort: number;
}

export interface InspectorIntegration {
	store: RequestStore;
	/** Resolves with the port the inspector actually bound to */
	start(): Promise<number>;
}

export function createInspectorIntegration(
	options: InspectorIntegrationOptions,
): InspectorIntegration {
	const { inspectPort, subdomainPortMap, tunnelUrls, defaultPort } = options;
	const store = new RequestStore();

	async function start(): Promise<number> {
		const handle = await startInspectorServer({
			port: inspectPort,
			store,
			onReplay: async (id) => {
				const original = store.get(id);
				if (!original) return null;
				const port = original.subdomain
					? (subdomainPortMap.get(original.subdomain) ?? defaultPort)
					: defaultPort;
				const start = Date.now();
				const response = await proxyRequest(
					{
						type: "request",
						id: `replay_${Date.now().toString(36)}`,
						method: original.method,
						path: original.path,
						headers: original.requestHeaders,
						body: original.requestBody,
					},
					port,
				);
				const entry: InspectorEntry = {
					id: `replay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
					timestamp: start,
					subdomain: original.subdomain,
					method: original.method,
					path: original.path,
					requestHeaders: original.requestHeaders,
					requestBody: original.requestBody,
					status: response.status,
					responseHeaders: response.headers,
					responseBody: response.body,
					durationMs: Date.now() - start,
					entryType: "replay",
					originalId: id,
				};
				store.add(entry);
				return entry;
			},
			onReplayCustom: async (req) => {
				const start = Date.now();
				const response = await proxyRequest(
					{
						type: "request",
						id: `custom_${Date.now().toString(36)}`,
						method: req.method,
						path: req.path,
						headers: req.headers,
						body: req.body,
					},
					defaultPort,
				);
				const entry: InspectorEntry = {
					id: `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
					timestamp: start,
					method: req.method,
					path: req.path,
					requestHeaders: req.headers,
					requestBody: req.body,
					status: response.status,
					responseHeaders: response.headers,
					responseBody: response.body,
					durationMs: Date.now() - start,
					entryType: "replay",
				};
				store.add(entry);
				return entry;
			},
			getTunnels: () =>
				[...subdomainPortMap.entries()].map(([subdomain, localPort]) => ({
					subdomain,
					localPort,
					url: tunnelUrls.get(subdomain) ?? "",
				})),
		});
		return handle.port;
	}

	return { store, start };
}
