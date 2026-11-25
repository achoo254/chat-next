/**
 * What the approval card of a Localman write shows of a request: its
 * headers with credentials masked, the start of its body with credentials
 * of known shapes hidden, and whether its URL is on the user's own machine
 * or network (Localman then sends it through that machine or a tunnel).
 */
import { isIP } from "node:net";
import type { WriteHeader } from "../providers/types.ts";
import { hideNamedSecrets, isCredentialHeader, redact } from "./redact.js";

const HEADER_VALUE_CHARS = 120;
export const BODY_EXCERPT_CHARS = 400;

/** Headers for the card: a credential's value left out, any other one cut and redacted. */
export function cardHeaders(headers: readonly { name: string; value: string }[]): WriteHeader[] {
	return headers.map(({ name, value }) =>
		isCredentialHeader(name)
			? { name, value: "", masked: true }
			: { name, value: redact(value.length > HEADER_VALUE_CHARS ? `${value.slice(0, HEADER_VALUE_CHARS)}…` : value), masked: false },
	);
}

/** The start of a body for the card, without bearer tokens, JWTs, API keys or named secrets. */
export function bodyExcerpt(body: string): string {
	return hideNamedSecrets(redact(body.slice(0, BODY_EXCERPT_CHARS)));
}

/** The URL's host is the user's own machine or network: localhost, a loopback, private or link-local address. */
export function reachesLocal(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	const version = isIP(host);
	if (version === 4) {
		const [a = 0, b = 0] = host.split(".").map(Number);
		return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	if (version === 6) {
		return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.");
	}
	return false;
}
