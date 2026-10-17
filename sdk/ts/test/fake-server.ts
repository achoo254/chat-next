import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake server received. */
export interface Recorded {
	readonly method: string;
	readonly url: URL;
	readonly headers: IncomingHttpHeaders;
	readonly body: Buffer;
}

/** Answers one recorded request. */
export type Route = (request: Recorded, res: ServerResponse) => void;

export interface FakeServer {
	/** Base URL, without a trailing slash. */
	readonly url: string;
	readonly requests: Recorded[];
	close(): Promise<void>;
}

/** An in-process HTTP server that records every request and lets `route` answer. */
export async function startFake(route: Route): Promise<FakeServer> {
	const requests: Recorded[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const recorded: Recorded = {
				method: req.method ?? "",
				url: new URL(req.url ?? "/", "http://fake"),
				headers: req.headers,
				body: Buffer.concat(chunks),
			};
			requests.push(recorded);
			route(recorded, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Writes a JSON answer. */
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(value));
}

/** Writes `{"ok": true, "result": result}`. */
export function ok(res: ServerResponse, result: unknown): void {
	sendJson(res, 200, { ok: true, result });
}

/** Writes an error envelope. */
export function fail(
	res: ServerResponse,
	status: number,
	code: string,
	retryAfter?: number,
	headers: Record<string, string> = {},
): void {
	const error = { code, description: `${code} happened`, ...(retryAfter === undefined ? {} : { retry_after: retryAfter }) };
	sendJson(res, status, { ok: false, error }, headers);
}

/** Drops the connection without an answer. */
export function hangUp(res: ServerResponse): void {
	res.socket?.destroy();
}

/** The JSON body of a recorded request. */
export function jsonOf(request: Recorded | undefined): unknown {
	if (request === undefined) {
		throw new Error("no such request");
	}
	return JSON.parse(request.body.toString("utf8"));
}
