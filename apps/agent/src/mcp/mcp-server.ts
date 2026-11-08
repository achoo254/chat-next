import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApiBaseUrl, listAccountTunnels } from "../api-client.js";
import { VERSION } from "../version.js";
import { whoAmI } from "../whoami.js";
import { registerLinkTools } from "./link-tools.js";
import { LocalTunnels } from "./local-tunnels.js";
import type { McpContext } from "./mcp-context.js";
import { attempt } from "./mcp-result.js";
import { listTunnelProcesses, registerProcessTools } from "./process-tools.js";
import { registerRequestTools } from "./request-tools.js";

const port = z.number().int().min(1).max(65535).describe("Local port");
const MAX_HTTP_TTL_S = 24 * 60 * 60;
const MAX_TCP_TTL_S = 8 * 60 * 60;

/**
 * `tunelo mcp`: lets an agent open, list and close tunnels on this machine
 * with the CLI's own sign-in, read the requests through them, stop other
 * local tunnel processes and manage the machine's links. Tunnels it opens
 * belong to this process.
 */
export function createTuneloMcpServer(context: McpContext): {
	server: McpServer;
	tunnels: LocalTunnels;
} {
	const tunnels = new LocalTunnels(context);
	const server = new McpServer({ name: "tunelo", version: VERSION });

	server.registerTool(
		"open_http_tunnel",
		{
			title: "Open an HTTP tunnel",
			description:
				"Expose a local HTTP port on a public HTTPS URL. Anyone with the URL can reach it unless `auth` (Basic Auth user:pass) is set. Closes when `ttl` runs out, on close_tunnel, or when this MCP server exits.",
			inputSchema: z.object({
				port,
				subdomain: z
					.string()
					.regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
					.optional()
					.describe("Requested subdomain; random when omitted"),
				auth: z
					.string()
					.regex(/^[^:]+:.+$/)
					.max(256)
					.optional()
					.describe("Require Basic Auth from visitors, as user:pass"),
				ttl: z
					.number()
					.int()
					.min(60)
					.max(MAX_HTTP_TTL_S)
					.optional()
					.describe("Seconds until the tunnel closes by itself"),
			}),
			annotations: { openWorldHint: true },
		},
		(args) =>
			attempt(() =>
				tunnels.openHttp({
					port: args.port,
					subdomain: args.subdomain,
					auth: args.auth,
					ttlSeconds: args.ttl,
				}),
			),
	);

	server.registerTool(
		"open_tcp_tunnel",
		{
			title: "Open a TCP tunnel",
			description:
				"Expose a local TCP port (database, SSH…) on a public port. Raw TCP has no access control on the server, so a `ttl` is required: the tunnel closes when it runs out, on close_tunnel, or when this MCP server exits.",
			inputSchema: z.object({
				port,
				ttl: z
					.number()
					.int()
					.min(60)
					.max(MAX_TCP_TTL_S)
					.describe("Seconds until the tunnel closes by itself (max 8 h)"),
			}),
			annotations: { openWorldHint: true },
		},
		(args) =>
			attempt(() => tunnels.openTcp({ port: args.port, ttlSeconds: args.ttl })),
	);

	server.registerTool(
		"list_local_tunnels",
		{
			title: "List tunnels on this machine",
			description:
				"`tunnels`: those this MCP server has open, with their ids. `processes`: `tunelo http`/`tcp` processes running on this machine, with their PIDs.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			attempt(async () => ({
				tunnels: tunnels.list(),
				processes: listTunnelProcesses(),
			})),
	);

	server.registerTool(
		"close_tunnel",
		{
			title: "Close a tunnel",
			description:
				"Close a tunnel this MCP server opened (id from list_local_tunnels).",
			inputSchema: z.object({ id: z.string().min(1).max(64) }),
			annotations: { destructiveHint: true, openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				if (!tunnels.close(args.id)) throw new Error(`No tunnel ${args.id}`);
				return { closed: args.id };
			}),
	);

	server.registerTool(
		"tunnel_status",
		{
			title: "Tunnel status",
			description:
				"Server, sign-in and tunnels: those open here and, when signed in, every live tunnel of the account on any machine.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			attempt(async () => {
				const credential = context.credential();
				const accountTunnels =
					credential?.kind === "account"
						? await listAccountTunnels(
								getApiBaseUrl(context.serverUrl),
								await credential.getKey(),
							)
						: undefined;
				return {
					server: context.serverUrl,
					signedIn: credential?.kind === "account",
					localTunnels: tunnels.list(),
					...(accountTunnels ? { accountTunnels } : {}),
				};
			}),
	);

	server.registerTool(
		"whoami",
		{
			title: "Who am I",
			description: "The account (or anonymous token) this machine tunnels as.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => attempt(() => whoAmI(context.serverUrl)),
	);

	registerRequestTools(server, tunnels);
	registerProcessTools(server);
	registerLinkTools(server, context);

	return { server, tunnels };
}
