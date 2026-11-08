import http from "node:http";
import {
	DEFAULTS,
	type TunnelRequest,
	type TunnelResponse,
} from "@tunelo/shared";

const HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

function filterHeaders(
	headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
	const filtered: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!HOP_HEADERS.has(key.toLowerCase())) {
			filtered[key] = value;
		}
	}
	return filtered;
}

export function proxyRequest(
	request: TunnelRequest,
	localPort: number,
	localHost = "localhost",
): Promise<TunnelResponse> {
	return new Promise((resolve) => {
		const body = request.body ? Buffer.from(request.body, "base64") : null;
		const headers = filterHeaders(request.headers);

		const proxyReq = http.request(
			{
				hostname: localHost,
				port: localPort,
				path: request.path,
				method: request.method,
				headers,
			},
			(proxyRes) => {
				const chunks: Buffer[] = [];
				let bodySize = 0;
				proxyRes.on("data", (chunk: Buffer) => {
					bodySize += chunk.length;
					if (bodySize > DEFAULTS.MAX_BODY_SIZE) {
						proxyReq.destroy();
						resolve({
							type: "response",
							id: request.id,
							status: 502,
							headers: { "content-type": "text/plain" },
							body: Buffer.from("Response body too large").toString("base64"),
						});
						return;
					}
					chunks.push(chunk);
				});
				proxyRes.on("end", () => {
					const responseBody =
						chunks.length > 0 ? Buffer.concat(chunks).toString("base64") : null;
					resolve({
						type: "response",
						id: request.id,
						status: proxyRes.statusCode ?? 502,
						headers: proxyRes.headers as Record<string, string | string[]>,
						body: responseBody,
					});
				});
			},
		);

		proxyReq.on("error", (err) => {
			const isRefused = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
			resolve({
				type: "response",
				id: request.id,
				status: isRefused ? 502 : 502,
				headers: { "content-type": "text/plain" },
				body: Buffer.from(
					isRefused ? "Local service unavailable" : (err as Error).message,
				).toString("base64"),
			});
		});

		proxyReq.setTimeout(30_000, () => {
			proxyReq.destroy();
			resolve({
				type: "response",
				id: request.id,
				status: 504,
				headers: { "content-type": "text/plain" },
				body: Buffer.from("Local service timeout").toString("base64"),
			});
		});

		if (body) proxyReq.write(body);
		proxyReq.end();
	});
}
