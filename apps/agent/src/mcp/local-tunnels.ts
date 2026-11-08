/**
 * Tunnels opened by one `tunelo mcp` client, held by the service: closing
 * one, its TTL running out, or the client disconnecting closes it.
 */
import { randomUUID } from "node:crypto";
import {
	type TcpRegisterResult,
	TunnelClient,
	type TunnelClientOptions,
} from "@tunelo/client";
import { type InspectorEntry, RequestStore } from "../tunnels/request-store.js";
import { TcpProxy } from "../tunnels/tcp-proxy.js";
import type { McpContext } from "./mcp-context.js";

const TCP_REGISTER_TIMEOUT_MS = 15_000;

export interface LocalTunnel {
	id: string;
	protocol: "http" | "tcp";
	url: string;
	localPort: number;
	openedAt: string;
	/** ISO time the TTL closes it; null = until closed or exit. */
	expiresAt: string | null;
}

interface Entry {
	info: LocalTunnel;
	client: TunnelClient;
	timer: ReturnType<typeof setTimeout> | null;
	/** Requests through an HTTP tunnel, as `tunelo http`'s inspector keeps them. */
	requests: RequestStore | null;
}

export class LocalTunnels {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly context: McpContext) {}

	/** Every client gets an error listener at once: an unheard "error" event
	 *  would throw and take the whole MCP server down. */
	private newClient(
		options: Omit<
			TunnelClientOptions,
			keyof ReturnType<McpContext["clientOptions"]>
		>,
	): TunnelClient {
		const client = new TunnelClient({
			...this.context.clientOptions(),
			...options,
		});
		client.on("error", (err: Error) =>
			this.context.log(`tunnel error: ${err.message}`),
		);
		return client;
	}

	list(): LocalTunnel[] {
		return [...this.entries.values()].map((entry) => entry.info);
	}

	/** The tunnel with this id and its request log (null for TCP). */
	requestLog(
		id: string,
	): { info: LocalTunnel; requests: RequestStore | null } | undefined {
		const entry = this.entries.get(id);
		return entry && { info: entry.info, requests: entry.requests };
	}

	async openHttp(options: {
		port: number;
		subdomain?: string | undefined;
		auth?: string | undefined;
		ttlSeconds?: number | undefined;
	}): Promise<LocalTunnel> {
		const client = this.newClient({
			localPort: options.port,
			subdomain: options.subdomain,
			auth: options.auth,
		});
		const requests = new RequestStore();
		client.on("inspector-entry", (entry: InspectorEntry) =>
			requests.add(entry),
		);
		const result = await client.connect().catch((err: unknown) => {
			client.disconnect();
			throw err;
		});
		return this.track(
			client,
			"http",
			result.url,
			options.port,
			options.ttlSeconds,
			requests,
		);
	}

	async openTcp(options: {
		port: number;
		ttlSeconds: number;
	}): Promise<LocalTunnel> {
		const client = this.newClient({ localPort: options.port, tcpOnly: true });
		try {
			await client.connect();
			// Listen only once connected: a failed connect must not leave a
			// pending promise whose timer rejects with nobody listening.
			const registered = this.awaitTcpRegistration(client);
			// Re-register after every reconnect, as `tunelo tcp` does.
			client.on("connected", () => client.registerTcp(options.port));
			client.registerTcp(options.port);
			const result = await registered;
			new TcpProxy(client, options.port);
			return this.track(
				client,
				"tcp",
				result.url,
				options.port,
				options.ttlSeconds,
				null,
			);
		} catch (err) {
			client.disconnect();
			throw err;
		}
	}

	private awaitTcpRegistration(
		client: TunnelClient,
	): Promise<TcpRegisterResult> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("TCP tunnel registration timed out")),
				TCP_REGISTER_TIMEOUT_MS,
			);
			client.once("tcp-registered", (result: TcpRegisterResult) => {
				clearTimeout(timer);
				resolve(result);
			});
			client.once("tcp-register-error", (result: TcpRegisterResult) => {
				clearTimeout(timer);
				reject(new Error(result.error ?? "TCP tunnel refused"));
			});
		});
	}

	/** Returns false when no tunnel has that id. */
	close(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		if (entry.timer) clearTimeout(entry.timer);
		entry.client.disconnect();
		this.entries.delete(id);
		return true;
	}

	closeAll(): void {
		for (const id of [...this.entries.keys()]) this.close(id);
	}

	private track(
		client: TunnelClient,
		protocol: LocalTunnel["protocol"],
		url: string,
		localPort: number,
		ttlSeconds: number | undefined,
		requests: RequestStore | null,
	): LocalTunnel {
		const id = randomUUID().slice(0, 8);
		const now = Date.now();
		const info: LocalTunnel = {
			id,
			protocol,
			url,
			localPort,
			openedAt: new Date(now).toISOString(),
			expiresAt: ttlSeconds
				? new Date(now + ttlSeconds * 1000).toISOString()
				: null,
		};
		const timer = ttlSeconds
			? setTimeout(() => this.close(id), ttlSeconds * 1000)
			: null;
		// A dead session (e.g. sign-in expired) ends the tunnel for good.
		client.on("error", () => {
			if (!client.isActive()) this.close(id);
		});
		this.entries.set(id, { info, client, timer, requests });
		return info;
	}
}
