/**
 * Approvals of write tools, held by the service. When the user approves a
 * write tool's card, the session gets one approval for that exact call
 * (its ticket, the tool, a digest of the arguments). The service runs a
 * write of a session only by spending one: a ticket alone, which other
 * processes of the user can read, never sends a message or a request.
 */
import { createHash } from "node:crypto";

export const APPROVAL_TTL_MS = 60_000;

/** JSON with keys sorted at every level, `undefined` members left out. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** What one approval is for: session, group, tool and arguments. */
function approvalKey(ticket: string, group: string, tool: string, args: unknown): string {
	const digest = createHash("sha256").update(canonical(args ?? {})).digest("base64url");
	return `${ticket}\n${group}\n${tool}\n${digest}`;
}

export class WriteApprovals {
	private readonly granted = new Map<string, number[]>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = APPROVAL_TTL_MS,
	) {}

	/** The user approved this call: it may run once, within the next minute. */
	grant(ticket: string, group: string, tool: string, args: unknown): void {
		this.prune();
		const key = approvalKey(ticket, group, tool, args);
		this.granted.set(key, [...(this.granted.get(key) ?? []), this.now() + this.ttlMs]);
	}

	/** Spends an approval of exactly this call; false when there is none. */
	consume(ticket: string, group: string, tool: string, args: unknown): boolean {
		this.prune();
		const key = approvalKey(ticket, group, tool, args);
		const left = this.granted.get(key);
		if (!left?.length) return false;
		left.shift();
		if (!left.length) this.granted.delete(key);
		return true;
	}

	/** Drops every approval of a session that ended. */
	forget(ticket: string): void {
		for (const key of [...this.granted.keys()]) if (key.startsWith(`${ticket}\n`)) this.granted.delete(key);
	}

	private prune(): void {
		const at = this.now();
		for (const [key, ends] of this.granted) {
			const live = ends.filter((end) => end > at);
			if (live.length) this.granted.set(key, live);
			else this.granted.delete(key);
		}
	}
}
