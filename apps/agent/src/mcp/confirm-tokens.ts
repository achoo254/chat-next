import { randomBytes } from "node:crypto";

/** How long a dry run's confirm token stays valid. */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000;

const RETRY_HINT = "Call the tool with dry_run=true again for a new token.";

/**
 * Two-step confirmation for tools that cannot be undone, as Localman's API
 * MCP does it: a `dry_run` call returns a token bound to the exact action,
 * and the real call must present it. A token works once, for a few minutes,
 * and only in this process.
 */
export class ConfirmTokens {
	private readonly pending = new Map<
		string,
		{ action: string; expiresAt: number }
	>();

	constructor(private readonly now: () => number = Date.now) {}

	issue(action: string): { confirm_token: string; expiresAt: string } {
		this.prune();
		const token = randomBytes(18).toString("base64url");
		const expiresAt = this.now() + CONFIRM_TOKEN_TTL_MS;
		this.pending.set(token, { action, expiresAt });
		return {
			confirm_token: token,
			expiresAt: new Date(expiresAt).toISOString(),
		};
	}

	/** Spends `token` on `action`; throws when it does not allow it. */
	consume(token: string | undefined, action: string): void {
		if (!token) {
			throw new Error(
				"This cannot be undone. Call the tool with dry_run=true first, show the preview to the user, then call again with the same input and the returned confirm_token.",
			);
		}
		this.prune();
		const entry = this.pending.get(token);
		if (!entry) {
			throw new Error(
				`confirm_token is unknown, expired or already used. ${RETRY_HINT}`,
			);
		}
		if (entry.action !== action) {
			throw new Error(
				`confirm_token was issued for another input. ${RETRY_HINT}`,
			);
		}
		this.pending.delete(token);
	}

	private prune(): void {
		const at = this.now();
		for (const [token, entry] of this.pending) {
			if (entry.expiresAt <= at) this.pending.delete(token);
		}
	}
}
