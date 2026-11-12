/**
 * The clients (Localman) still linked to this machine's anonymous token,
 * over MCP: listed and revoked. Revoking cannot be undone (no new link can
 * be made that way), so it takes a dry run and a confirm token.
 */
import { z } from "zod";
import {
	type LinkInfo,
	getApiBaseUrl,
	listLinks,
	revokeLink,
} from "../tunnels/api-client.js";
import {
	LINKS_NOT_NEEDED_MESSAGE,
	NO_ANONYMOUS_TOKEN_MESSAGE,
	OTHER_SERVER_SESSION_MESSAGE,
	linkContextOf,
	linkStateOf,
} from "../tunnels/anonymous-links.ts";
import { ConfirmTokens } from "./confirm-tokens.js";
import type { ToolRegistrar } from "./groups.js";
import type { McpContext } from "./mcp-context.js";
import { attempt } from "./mcp-result.js";

type LinkAccess =
	| { needed: false }
	| { needed: true; baseUrl: string; key: string; note?: string };

/** Only a machine on an anonymous token has links. */
function linkAccess(context: McpContext): LinkAccess {
	const link = linkContextOf(
		linkStateOf(context.dir),
		context.serverUrl,
		process.env.TUNELO_KEY,
	);
	if (link.kind === "not-needed") return { needed: false };
	if (link.kind === "no-key") throw new Error(NO_ANONYMOUS_TOKEN_MESSAGE);
	return {
		needed: true,
		baseUrl: getApiBaseUrl(context.serverUrl),
		key: link.key,
		...(link.otherServerSession ? { note: OTHER_SERVER_SESSION_MESSAGE } : {}),
	};
}

async function findLink(
	baseUrl: string,
	key: string,
	id: string,
): Promise<LinkInfo> {
	const link = (await listLinks(baseUrl, key)).find((row) => row.id === id);
	if (!link) throw new Error(`No link ${id} (see list_linked_machines).`);
	return link;
}

export function registerLinkTools(
	server: ToolRegistrar,
	context: McpContext,
): void {
	const confirmTokens = new ConfirmTokens();

	server.registerTool(
		"list_linked_machines",
		{
			title: "List linked clients",
			description:
				"Clients (such as Localman) linked earlier, by code, to see this machine's tunnels. Only machines on an anonymous token have links; a signed-in machine shares its tunnels through the account.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			attempt(async () => {
				const access = linkAccess(context);
				if (!access.needed) {
					return { links: [], note: LINKS_NOT_NEEDED_MESSAGE };
				}
				const links = await listLinks(access.baseUrl, access.key);
				return { links, ...(access.note ? { note: access.note } : {}) };
			}),
	);

	server.registerTool(
		"revoke_linked_machine",
		{
			title: "Revoke a linked client",
			description:
				"Stop a linked client from seeing this machine's tunnels. Cannot be undone: such a link cannot be made again (sign the machine in with `tunelo login` instead). Two steps: call with dry_run=true to get a preview and a confirm_token, show the preview to the user, then call again with the same id and that confirm_token.",
			inputSchema: z.object({
				id: z
					.string()
					.min(1)
					.max(64)
					.describe("Link id from list_linked_machines"),
				dry_run: z
					.boolean()
					.optional()
					.describe("Preview the revocation and get a confirm_token"),
				confirm_token: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe("Token from the dry run, to revoke for real"),
			}),
			annotations: { destructiveHint: true, openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				const access = linkAccess(context);
				if (!access.needed) throw new Error(LINKS_NOT_NEEDED_MESSAGE);
				const action = `${access.baseUrl} ${args.id}`;
				if (args.dry_run) {
					const link = await findLink(access.baseUrl, access.key, args.id);
					return {
						preview: { action: "revoke", link },
						...confirmTokens.issue(action),
					};
				}
				confirmTokens.consume(args.confirm_token, action);
				await revokeLink(access.baseUrl, access.key, args.id);
				return { revoked: args.id };
			}),
	);
}
