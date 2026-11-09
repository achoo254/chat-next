/**
 * Tickets of the claude sessions tunelo opens. Each session's `tunelo mcp`
 * gets one in `TUNELO_MCP_TICKET`, so the service knows which session a
 * tool call comes from. A ticket only names a session: it is no credential
 * and never turns into a token. It ends with the session.
 */
import { randomBytes } from "node:crypto";
import type { SessionSecretHooks } from "../sign-in-secrets/secret-env.ts";

/** What a session needs to start tunelo's MCP, and to have its writes approved. */
export interface SessionMcp {
	ticket: string;
	/** tunelo's config folder, for the `tunelo mcp` the session starts. */
	configDir: string;
	/** The user approved this call of a write tool on the device: the service lets it run once. */
	approveWrite(claudeName: string, input: Record<string, unknown>): void;
	/** One line for a write's approval card (recipient, URL); undefined to keep the default. */
	describeWrite(claudeName: string, input: Record<string, unknown>): Promise<string | undefined>;
	/** The session's sign-in secrets in its commands; absent when the machine keeps none. */
	secrets?: SessionSecretHooks;
	/** What happened in the tunelo browser that Claude hears with its next tool result, taken once. */
	browserNotices?: () => string[];
}

/** A session's MCP, with the end of its ticket (when the session ends). */
export interface SessionMcpLease extends SessionMcp {
	release(): void;
}

export const TICKET_ENV = "TUNELO_MCP_TICKET";

export class SessionTickets {
	private readonly owners = new Map<string, string>();

	/** A new ticket (256 bits) for the session `label` names. */
	issue(label: string): string {
		const ticket = randomBytes(32).toString("base64url");
		this.owners.set(ticket, label);
		return ticket;
	}

	/** The session of a live ticket. */
	owner(ticket: string): string | undefined {
		return this.owners.get(ticket);
	}

	revoke(ticket: string): void {
		this.owners.delete(ticket);
	}
}
