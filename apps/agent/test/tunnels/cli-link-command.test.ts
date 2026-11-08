import { describe, expect, it } from "vitest";
import { linkContextOf } from "./cli-link-command.js";
import type { StoredSession } from "./config.js";

const SERVER = "wss://tunnel.hoandat.com";

function sessionOf(issuer: string): StoredSession {
	return { issuer, sub: "acc_test", refreshToken: "refresh-test" };
}

describe("linkContextOf", () => {
	it("needs no link when the sign-in is for this server", () => {
		const config = {
			session: sessionOf("https://auth.hoandat.com"),
			key: "tunelo_anon",
		};
		expect(linkContextOf(config, SERVER, undefined)).toEqual({
			kind: "not-needed",
		});
	});

	it("links with the anonymous token when the sign-in is for another server", () => {
		// A session from before the domain move: `tunelo http` uses the
		// anonymous token, so Localman can only see the tunnels through a link.
		const config = {
			session: sessionOf("https://auth.inetdev.io.vn"),
			key: "tunelo_anon",
		};
		expect(linkContextOf(config, SERVER, undefined)).toEqual({
			kind: "anonymous",
			key: "tunelo_anon",
			otherServerSession: true,
		});
	});

	it("links a machine without a sign-in, preferring TUNELO_KEY", () => {
		expect(
			linkContextOf({ key: "tunelo_saved" }, SERVER, "tunelo_env"),
		).toEqual({
			kind: "anonymous",
			key: "tunelo_env",
			otherServerSession: false,
		});
	});

	it("reports a machine with neither a usable sign-in nor a token", () => {
		const config = { session: sessionOf("https://auth.inetdev.io.vn") };
		expect(linkContextOf(config, SERVER, undefined)).toEqual({
			kind: "no-key",
		});
	});
});
