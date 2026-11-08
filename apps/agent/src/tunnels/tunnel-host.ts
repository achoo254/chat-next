/**
 * Opens the tunnel of one `tunelo http` / `tunelo tcp` and reports what
 * happens as plain events. The background service runs it for a terminal
 * (the events go back over the control socket) and a terminal runs it
 * itself when no service is running; either way the terminal prints the
 * events as the Tunelo CLI 1.x did.
 */
import {
	type RegisterTunnelResult,
	type TcpRegisterResult,
	TunnelClient,
	type TunnelInspectorEntry,
	type TunnelRequestLog,
} from "@tunelo/client";
import { z } from "zod";
import type { Credential } from "../identity/credentials.ts";
import { TcpProxy } from "./tcp-proxy.js";

const port = z.number().int().min(1).max(65535);
const subdomain = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
const server = z
	.string()
	.max(512)
	.regex(/^(https?|wss?):\/\//, "a http(s) or ws(s) URL");

/** A tunnel to open, as the terminal sends it to the service. */
export const tunnelSpecSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("http"),
		server,
		tunnels: z
			.array(z.object({ port, subdomain: subdomain.optional() }))
			.min(1)
			.max(10),
		subdomain: subdomain.optional(),
		auth: z
			.string()
			.regex(/^[^:]+:.+$/)
			.max(256)
			.optional(),
	}),
	z.object({
		kind: z.literal("tcp"),
		server,
		port,
		remotePort: port.optional(),
	}),
]);

export type TunnelSpec = z.infer<typeof tunnelSpecSchema>;

export type TunnelEvent =
	| { type: "connected"; url: string; subdomain: string }
	| {
			type: "tunnel-registered";
			subdomain: string;
			url: string;
			localPort: number;
	  }
	| { type: "tunnel-register-error"; subdomain: string; error: string }
	| { type: "tcp-registered"; url: string }
	| { type: "tcp-register-error"; error: string }
	| ({ type: "request" } & TunnelRequestLog)
	| { type: "inspector-entry"; entry: TunnelInspectorEntry }
	| { type: "legacy-token"; date: string }
	| { type: "disconnected" }
	| { type: "reconnecting"; attempt: number; delay: number }
	| { type: "error"; message: string }
	/** The tunnel could not open, or stopped for good. */
	| { type: "failed"; message: string }
	/** Closed by tunelo itself (`tunelo kill`, the service stopping). */
	| { type: "closed"; reason: string };

export interface HostedTunnel {
	close(): void;
}

export interface TunnelDevice {
	deviceId: string;
	deviceName: string;
}

function errorText(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** Opens the tunnel; `emit` hears every event until `close()` or `failed`. */
export function hostTunnel(
	spec: TunnelSpec,
	credential: Credential,
	device: TunnelDevice,
	emit: (event: TunnelEvent) => void,
): HostedTunnel {
	const base = {
		serverUrl: spec.server,
		getApiKey: credential.getKey,
		...device,
	};
	const client =
		spec.kind === "http"
			? new TunnelClient({
					...base,
					subdomain: spec.subdomain ?? spec.tunnels[0]?.subdomain,
					localPort: spec.tunnels[0]?.port ?? 0,
					auth: spec.auth,
					additionalTunnels: spec.tunnels
						.slice(1)
						.map(({ port, subdomain }) =>
							subdomain ? { port, subdomain } : { port },
						),
				})
			: new TunnelClient({ ...base, localPort: spec.port, tcpOnly: true });
	let proxy: TcpProxy | null = null;
	let failed = false;
	const fail = (message: string): void => {
		if (failed) return;
		failed = true;
		emit({ type: "failed", message });
	};

	client.on("connected", (result: { url: string; subdomain: string }) => {
		emit({ type: "connected", url: result.url, subdomain: result.subdomain });
		if (spec.kind === "tcp") client.registerTcp(spec.port, spec.remotePort);
	});
	client.on("tunnel-registered", (result: RegisterTunnelResult) => {
		emit({
			type: "tunnel-registered",
			subdomain: result.subdomain,
			url: result.url ?? "",
			localPort: result.localPort,
		});
	});
	client.on("tunnel-register-error", (result: RegisterTunnelResult) => {
		emit({
			type: "tunnel-register-error",
			subdomain: result.subdomain,
			error: result.error ?? "refused",
		});
	});
	client.on("tcp-registered", (result: TcpRegisterResult) => {
		emit({ type: "tcp-registered", url: result.url ?? "" });
		// One proxy for the life of the tunnel: it follows the client across reconnects.
		if (spec.kind === "tcp" && !proxy) proxy = new TcpProxy(client, spec.port);
	});
	client.on("tcp-register-error", (result: TcpRegisterResult) => {
		emit({ type: "tcp-register-error", error: result.error ?? "refused" });
	});
	client.on("request", (log: TunnelRequestLog) =>
		emit({ type: "request", ...log }),
	);
	client.on("inspector-entry", (entry: TunnelInspectorEntry) =>
		emit({ type: "inspector-entry", entry }),
	);
	client.on("legacy-token", (date: string) =>
		emit({ type: "legacy-token", date }),
	);
	client.on("disconnected", () => emit({ type: "disconnected" }));
	client.on("reconnecting", (info: { attempt: number; delay: number }) =>
		emit({ type: "reconnecting", ...info }),
	);
	client.on("error", (err: Error) => {
		emit({ type: "error", message: err.message });
		// A dead sign-in or refused name ends the tunnel for good.
		if (!client.isActive()) fail(err.message);
	});

	client.connect().catch((err: unknown) => {
		client.disconnect();
		fail(errorText(err));
	});

	return {
		close() {
			client.disconnect();
			proxy?.close();
		},
	};
}
