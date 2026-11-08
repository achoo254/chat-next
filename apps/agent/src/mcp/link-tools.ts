/**
 * `tunelo links` / `links revoke <id>` over MCP: the clients (Localman)
 * linked to this machine's anonymous token. Revoking cannot be undone (a
 * person has to link again), so it takes a dry run and a confirm token.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type LinkInfo,
	getApiBaseUrl,
	listLinks,
	revokeLink,
} from "../api-client.js";
import {
	LINKS_NOT_NEEDED_MESSAGE,
	NO_ANONYMOUS_TOKEN_MESSAGE,
	OTHER_SERVER_SESSION_MESSAGE,
	linkContextOf,
} from "../cli-link-command.js";
import { loadConfig } from "../config.js";
import { ConfirmTokens } from "./confirm-tokens.js";
import type { McpContext } from "./mcp-context.js";
import { attempt } from "./mcp-result.js";

type LinkAccess =
	| { needed: false }
	| { needed: true; baseUrl: string; key: string; note?: string };

/** Same rule as `tunelo links`: only a machine on an anonymous token has links. */
function linkAccess(context: McpContext): LinkAccess {
	const link = linkContextOf(
		loadConfig(),
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
	server: McpServer,
	context: McpContext,
): void {
	const confirmTokens = new ConfirmTokens();

	server.registerTool(
		"list_linked_machines",
		{
			title: "List linked clients",
			description:
				"Clients (such as Localman) linked with `tunelo link` to see this machine's tunnels. Only machines on an anonymous token have links; a signed-in machine shares its tunnels through the account.",
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
				"Stop a linked client from seeing this machine's tunnels. Cannot be undone: linking again needs a person with a new code. Two steps: call with dry_run=true to get a preview and a confirm_token, show the preview to the user, then call again with the same id and that confirm_token.",
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
