/**
 * Tickets of the AI sessions tunelo opens. A session presents its ticket to
 * the service's MCP endpoint (`TUNELO_MCP_HTTP_TICKET` in the AI's
 * environment) or hands it to its `tunelo mcp` (`TUNELO_MCP_TICKET`), so the
 * service knows which session a tool call comes from. A ticket never turns
 * into a token of an app, but it is a bearer: whoever holds it runs the
 * session's read tools, and its writes once approved on the device. It ends
 * with the session.
 */
import { randomBytes } from "node:crypto";
import type { SessionSecretHooks } from "../sign-in-secrets/secret-env.ts";

/** What a session needs to start tunelo's MCP, and to have its writes approved. */
export interface SessionMcp {
	ticket: string;
	/** tunelo's config folder, for the `tunelo mcp` the session starts. */
	configDir: string;
	/**
	 * The service's own MCP endpoint (session-mcp-http.ts): the session connects
	 * there instead of starting `tunelo mcp`; absent where it does not serve one.
	 */
	url?: string;
	/** The user approved this call of a write tool on the device: the service lets it run once. */
	approveWrite(exposed: string, input: Record<string, unknown>): void;
	/** One line for a write's approval card (recipient, URL); undefined to keep the default. */
	describeWrite(exposed: string, input: Record<string, unknown>): Promise<string | undefined>;
	/** The session's sign-in secrets in its commands; absent when the machine keeps none. */
	secrets?: SessionSecretHooks;
	/** What happened in the tunelo browser that the AI hears with its next tool result, taken once. */
	browserNotices?: () => string[];
	/** Advisor may be asked in this session now: its advisor_weigh calls go on without an approval card. */
	advisorAllowed?: () => boolean;
	/**
	 * The turn is about to end: what to tell the AI when automatic Advisor was on all
	 * along and it never asked for next steps (it goes on, once); undefined to let it end.
	 */
	advisorStop?: () => string | undefined;
	/** The session is an Advisor thread's: its `tunelo mcp` offers Advisor's tools only (TUNELO_MCP_ADVISOR). */
	advisorSession?: boolean;
	/** The ticket offers advisor_weigh and nothing else (a terminal's CLI): its `tunelo mcp` lists that tool only (TUNELO_MCP_ADVISOR_WEIGH). */
	advisorWeighOnly?: boolean;
}

/** A session's MCP, with the end of its ticket (when the session ends). */
export interface SessionMcpLease extends SessionMcp {
	release(): void;
}

export const TICKET_ENV = "TUNELO_MCP_TICKET";
/**
 * The ticket in the AI's own environment for the service's MCP endpoint,
 * which its MCP config names as `${TUNELO_MCP_HTTP_TICKET}`. Not TICKET_ENV:
 * a `tunelo mcp` the user added to the CLI inherits the AI's environment
 * and must not take the session's ticket for its own.
 */
export const HTTP_TICKET_ENV = "TUNELO_MCP_HTTP_TICKET";
/** Set ("1") for an Advisor thread's `tunelo mcp`: it lists Advisor's tools and nothing else. */
export const ADVISOR_MCP_ENV = "TUNELO_MCP_ADVISOR";
/** Set ("1") for the `tunelo mcp` of a CLI in a terminal: it lists advisor_weigh and nothing else. */
export const ADVISOR_WEIGH_MCP_ENV = "TUNELO_MCP_ADVISOR_WEIGH";

/**
 * What a ticket offers: every tool of a session tunelo opened ("session"),
 * or advisor_weigh alone ("advisor-weigh": the AI's own CLI in a terminal,
 * which gets no secrets, browser, Chat or Localman tools).
 */
export type TicketScope = "session" | "advisor-weigh";

export class SessionTickets {
	private readonly owners = new Map<string, { label: string; scope: TicketScope }>();

	/** A new ticket (256 bits) for the session `label` names. */
	issue(label: string, scope: TicketScope = "session"): string {
		const ticket = randomBytes(32).toString("base64url");
		this.owners.set(ticket, { label, scope });
		return ticket;
	}

	/** The session of a live ticket. */
	owner(ticket: string): string | undefined {
		return this.owners.get(ticket)?.label;
	}

	/** What a live ticket offers; undefined for an unknown or ended one. */
	scope(ticket: string): TicketScope | undefined {
		return this.owners.get(ticket)?.scope;
	}

	revoke(ticket: string): void {
		this.owners.delete(ticket);
	}
}
