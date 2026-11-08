/** Binds an HTTP server to the first free port, so a second CLI run never dies on EADDRINUSE */

import type http from "node:http";

export interface ListenResult {
	/** Port the server is actually bound to */
	port: number;
	/** True when the preferred port was taken and another one was used */
	fellBack: boolean;
}

export interface ListenOptions {
	host?: string;
	/** How many consecutive ports to probe before falling back to an ephemeral one */
	maxAttempts?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_ATTEMPTS = 20;
const MAX_PORT = 65535;

/**
 * Listens on `preferredPort`, then `preferredPort + 1`, ... until one binds.
 * If every candidate is taken, falls back to an OS-assigned ephemeral port.
 * Errors other than "port unavailable" reject so real failures stay visible.
 */
export async function listenWithPortFallback(
	server: http.Server,
	preferredPort: number,
	options: ListenOptions = {},
): Promise<ListenResult> {
	const host = options.host ?? DEFAULT_HOST;
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = preferredPort + attempt;
		if (candidate > MAX_PORT) break;
		if (await tryListen(server, candidate, host)) {
			return {
				port: resolveBoundPort(server, candidate),
				fellBack: attempt > 0,
			};
		}
	}

	// Every candidate was taken — let the OS pick any free port.
	if (await tryListen(server, 0, host)) {
		return { port: resolveBoundPort(server, 0), fellBack: true };
	}

	throw new Error(
		`No free port available near ${preferredPort} on ${host} (tried ${maxAttempts} ports + ephemeral)`,
	);
}

/** Resolves to false when the port is unusable, rejects on any other listen error */
function tryListen(
	server: http.Server,
	port: number,
	host: string,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			server.removeListener("listening", onListening);
			if (err.code === "EADDRINUSE" || err.code === "EACCES") {
				resolve(false);
				return;
			}
			reject(err);
		};

		const onListening = () => {
			server.removeListener("error", onError);
			resolve(true);
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

/** address() is null for non-TCP handles; fall back to the requested port */
function resolveBoundPort(server: http.Server, requested: number): number {
	const address = server.address();
	if (address && typeof address === "object") return address.port;
	return requested;
}
