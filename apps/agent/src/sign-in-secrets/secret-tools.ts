/**
 * The sign-in secret tools of tunelo's MCP, offered only to the claude
 * sessions tunelo opens (the user answers on a paired device): Claude asks
 * for a secret and gets a reference, then has tunelo fill it into a page or
 * names it in a command. No tool ever returns a value.
 */
import { z } from "zod";
import type { ToolRegistrar } from "../mcp/groups.js";
import { attempt } from "../mcp/mcp-result.js";
import { MAX_PURPOSE_CHARS, SECRET_NAME } from "./secret-names.ts";
import type { SecretService, SecretSession } from "./secret-service.ts";

/** Not a group of groups.ts: it cannot be turned off, and only sessions with a ticket have it. */
export const SECRETS_GROUP = "secrets";
export const SECRET_TOOLS = ["request_secret", "fill_secret"] as const;

const NO_SESSION = "Sign-in secrets are only offered in a session tunelo opened (the user answers on a paired device).";

const USAGE =
	"Use the reference, never ask the user to type the value in the chat: fill_secret puts it into a field of a page of that site in the browser you drive; in a Bash command write $TUNELO_SECRET_<NAME> (tunelo sets it for that command only, after the user approves the command). Outputs that echo it show [hidden].";

/**
 * Registers request_secret and fill_secret. `bound` is the service and the
 * session they run for; absent where the tools are only listed (`tunelo mcp`).
 */
export function registerSecretTools(server: ToolRegistrar, bound?: { service: SecretService; session: SecretSession }): void {
	const service = () => {
		if (!bound) throw new Error(NO_SESSION);
		return bound;
	};

	server.registerTool(
		"request_secret",
		{
			title: "Ask the user for a sign-in secret",
			description: `Get a password, token or other sign-in secret for a site without ever seeing it. When the machine keeps one for that site and name you get its reference at once; otherwise the user is asked on their device (a card outside the chat) and this waits up to 5 minutes. Returns { ref, name, origin, env }, or an error when the user declined or nobody answered. ${USAGE}`,
			inputSchema: z.object({
				name: z.string().regex(SECRET_NAME).describe("What to call it: upper-case letters, digits and _, e.g. GITHUB_PASSWORD"),
				purpose: z.string().min(1).max(MAX_PURPOSE_CHARS).describe("One sentence the user reads: why you need it"),
				origin: z.string().min(1).max(300).describe("The site it is for, as https://host (http only for localhost)"),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				const { service: s, session } = service();
				return { ...(await s.request(session, args)), usage: USAGE };
			}),
	);

	server.registerTool(
		"fill_secret",
		{
			title: "Fill a secret into a page",
			description:
				"Fill a secret (its ref from request_secret) into a field of a page in the browser you drive, over the Chrome DevTools Protocol. Only a page of the secret's own site is filled. The field is `selector`, else the focused field, else the only password field. The browser must listen on a debugging port (--remote-debugging-port); tunelo finds it, or give cdp_url (http://127.0.0.1:<port>). When no browser can be reached, use $TUNELO_SECRET_<NAME> in a command instead.",
			inputSchema: z.object({
				ref: z.string().min(1).max(100).describe("secret://… from request_secret"),
				selector: z.string().min(1).max(500).optional().describe("CSS selector of the field"),
				cdp_url: z.string().min(1).max(200).optional().describe("The browser's debugging address, http://127.0.0.1:<port>"),
			}),
			annotations: { openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				const { service: s, session } = service();
				return s.fill(session, { ref: args.ref, ...(args.selector ? { selector: args.selector } : {}), ...(args.cdp_url ? { cdpUrl: args.cdp_url } : {}) });
			}),
	);
}
