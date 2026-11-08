/**
 * Tickets of the claude sessions tunelo opens. Each session's `tunelo mcp`
 * gets one in `TUNELO_MCP_TICKET`, so the service knows which session a
 * tool call comes from. A ticket only names a session: it is no credential
 * and never turns into a token. It ends with the session.
 */
import { randomBytes } from "node:crypto";

/** What a session needs to start tunelo's MCP. */
export interface SessionMcp {
	ticket: string;
	/** tunelo's config folder, for the `tunelo mcp` the session starts. */
	configDir: string;
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
