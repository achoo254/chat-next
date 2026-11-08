import http from "node:http";

export interface FakeIdp {
	issuer: string;
	/** Bodies of every POST, by path. */
	requests: { path: string; form: URLSearchParams }[];
	/** Replies of the token endpoint, consumed in order (the last repeats). */
	tokenReplies: { status: number; body: unknown }[];
	close(): Promise<void>;
}

/** A local identity provider: discovery, device authorization, token, revocation. */
export async function startFakeIdp(): Promise<FakeIdp> {
	const requests: FakeIdp["requests"] = [];
	const tokenReplies: FakeIdp["tokenReplies"] = [];
	let issuer = "";
	const send = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(body === "" ? "" : JSON.stringify(body));
	};
	const server = http.createServer((req, res) => {
		if (
			req.method === "GET" &&
			req.url === "/.well-known/openid-configuration"
		) {
			send(res, 200, {
				issuer,
				device_authorization_endpoint: `${issuer}/device/auth`,
				token_endpoint: `${issuer}/token`,
				revocation_endpoint: `${issuer}/token/revocation`,
			});
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const path = req.url ?? "";
			requests.push({
				path,
				form: new URLSearchParams(Buffer.concat(chunks).toString()),
			});
			if (path === "/device/auth") {
				send(res, 200, {
					device_code: "dev-code",
					user_code: "WDJB-MJHT",
					verification_uri: `${issuer}/device`,
					verification_uri_complete: `${issuer}/device?user_code=WDJB-MJHT`,
					expires_in: 600,
					interval: 5,
				});
			} else if (path === "/token") {
				const reply =
					tokenReplies.length > 1 ? tokenReplies.shift() : tokenReplies[0];
				send(
					res,
					reply?.status ?? 500,
					reply?.body ?? { error: "server_error" },
				);
			} else if (path === "/token/revocation") {
				send(res, 200, "");
			} else {
				send(res, 404, { error: "not_found" });
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	return {
		issuer,
		requests,
		tokenReplies,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** An unsigned JWT-shaped token carrying `sub` (the CLI only reads it). */
export function fakeJwt(sub: string): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ sub })}.sig`;
}
