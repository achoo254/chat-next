// Two tunelo processes needing a token at once share one rotating refresh
// token. The IdP below behaves like auth-next: each refresh token works
// once, and replaying a used one revokes the whole grant (the machine is
// signed out). The session lock must make every refresh use the newest one.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { IdentitySession } from "../src/identity/session.ts";
import { bundleForNode } from "./support/bundle.ts";
import { fakeJwt } from "./support/fake-idp.ts";

const run = promisify(execFile);
const TUNNEL = "https://tunnel.example";
const CHAT = "https://chat.example/mcp";

interface RotatingIdp {
	issuer: string;
	/** Refresh tokens presented, in order. */
	presented: string[];
	revoked: boolean;
	close(): Promise<void>;
}

async function startRotatingIdp(): Promise<RotatingIdp> {
	let current = "rt-1";
	let n = 1;
	const used = new Set<string>();
	const state = { presented: [] as string[], revoked: false };
	let issuer = "";
	const server = http.createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.url === "/.well-known/openid-configuration") {
			send(200, { issuer, device_authorization_endpoint: `${issuer}/device`, token_endpoint: `${issuer}/token` });
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const form = new URLSearchParams(Buffer.concat(chunks).toString());
			const rt = form.get("refresh_token") ?? "";
			state.presented.push(rt);
			if (state.revoked || used.has(rt) || rt !== current) {
				// Replay of a rotated token: the grant is gone for everyone.
				if (used.has(rt)) state.revoked = true;
				send(400, { error: "invalid_grant" });
				return;
			}
			used.add(rt);
			current = `rt-${++n}`;
			const resource = form.get("resource") ?? "";
			// Slow enough that both processes are waiting at once.
			setTimeout(() => send(200, { access_token: fakeJwt(`acc_alice ${resource} ${n}`), refresh_token: current, expires_in: 900 }), 300);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	return {
		issuer,
		get presented() {
			return state.presented;
		},
		get revoked() {
			return state.revoked;
		},
		close: () => new Promise((r) => server.close(() => r())),
	};
}

let child = "";
let idp: RotatingIdp;
let dir = "";

beforeAll(async () => {
	child = await bundleForNode("test/support/session-child.ts", "session-child");
});

beforeEach(async () => {
	await idp?.close();
	idp = await startRotatingIdp();
	dir = mkdtempSync(join(tmpdir(), "tunelo-two-"));
	// Signed in, the access token already expired.
	await new IdentitySession(dir).adopt({ issuer: idp.issuer, sub: "acc_alice", refreshToken: "rt-1", accessToken: "old", accessTokenExpiresAt: 1 }, TUNNEL);
	return () => rmSync(dir, { recursive: true, force: true });
});

afterAll(() => idp?.close());

async function tokenIn(resource: string): Promise<{ token?: string; error?: string }> {
	const { stdout } = await run(process.execPath, [child, dir, resource], { env: process.env, timeout: 20_000 });
	return JSON.parse(stdout) as { token?: string; error?: string };
}

describe("two processes, one session", () => {
	test("both need the same token: one refresh, and the other reads the new token", async () => {
		const [a, b] = await Promise.all([tokenIn(TUNNEL), tokenIn(TUNNEL)]);
		expect(a.error).toBeUndefined();
		expect(b.error).toBeUndefined();
		expect(a.token).toBe(b.token);
		expect(idp.presented).toEqual(["rt-1"]);
		expect(idp.revoked).toBe(false);
	});

	test("tokens for two resources at once: each refresh uses the newest refresh token", async () => {
		const [tunnel, chat] = await Promise.all([tokenIn(TUNNEL), tokenIn(CHAT)]);
		expect(tunnel.error).toBeUndefined();
		expect(chat.error).toBeUndefined();
		expect(new Set(idp.presented)).toEqual(new Set(["rt-1", "rt-2"]));
		expect(idp.revoked).toBe(false);
		// Both access tokens are now on disk (sealed): a third process refreshes nothing.
		await tokenIn(CHAT);
		expect(idp.presented).toHaveLength(2);
	});
});
