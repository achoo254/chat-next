import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import {
	type ControlStream,
	callControl,
	streamControl,
} from "../control-socket.ts";
import {
	printServerMigration,
	resolveServerUrl,
} from "../tunnels/server-url.js";
import { AGENT_VERSION } from "../version.ts";
import { TOOL_GROUPS, ToolTable } from "./groups.js";
import { LocalTunnels } from "./local-tunnels.js";
import { type McpContext, createMcpContext } from "./mcp-context.js";
import type { OfferedTool } from "./mcp-host.ts";
import { failure } from "./mcp-result.js";
import { LOCAL_WRITES_OFF, LocalWritesSetting } from "./local-writes.js";
import { redactMessage } from "./redact.js";
import { TICKET_ENV } from "./session-tickets.js";

const NOT_RUNNING =
	"tunelo is not running in the background: run `tunelo start`, then call the tool again.";
/** How long the list waits for the service to name the Chat and Localman tools. */
const REMOTE_LIST_WAIT_MS = 8_000;

type ToolArgs = Record<string, unknown>;

/**
 * This client's session in the background service. It lasts while the
 * stream to the service stays open; a restarted service gets a new one on
 * the next call (the tunnels of the old one closed with it).
 */
class ServiceSession {
	private pending: Promise<{ id: string; stream: ControlStream }> | null =
		null;

	constructor(
		private readonly dir: string,
		private readonly serverUrl: string,
		private readonly ticket: string | undefined,
	) {}

	id(): Promise<string> {
		this.pending ??= this.open();
		return this.pending.then((session) => session.id);
	}

	private async open(): Promise<{ id: string; stream: ControlStream }> {
		let resolveId: (id: string) => void = () => undefined;
		let refusal = "";
		const idReady = new Promise<string>((resolve) => (resolveId = resolve));
		const stream = await streamControl(
			this.dir,
			"/mcp/session",
			{ server: this.serverUrl, ...(this.ticket ? { ticket: this.ticket } : {}) },
			(message) => {
				const { session, type, message: text } = message as { session?: unknown; type?: unknown; message?: unknown };
				if (typeof session === "string") resolveId(session);
				if (type === "failed" && typeof text === "string") refusal = text;
			},
		).catch((err: unknown) => {
			this.pending = null;
			throw err;
		});
		void stream.done.then(() => {
			this.pending = null;
			resolveId("");
		});
		const id = await idReady;
		if (!id) throw new Error(refusal || NOT_RUNNING);
		return { id, stream };
	}

	close(): void {
		void this.pending?.then((session) => session.stream.close()).catch(() => undefined);
	}
}

function isToolResult(value: unknown): value is CallToolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { content?: unknown }).content)
	);
}

/** Arguments as the server's JSON Schema advertises them; the server itself validates them. */
function advertisedSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<ToolArgs> {
	return {
		"~standard": {
			version: 1,
			vendor: "tunelo",
			validate: (value) =>
				typeof value === "object" && value !== null && !Array.isArray(value)
					? { value: value as ToolArgs }
					: { issues: [{ message: "Tool arguments must be a JSON object" }] },
			jsonSchema: { input: () => schema, output: () => schema },
		},
	};
}

/**
 * The Chat and Localman tools the service offers this client now, and
 * whether it may write. Without the service: no remote tools, and writes as
 * the machine's setting says (a call then says to start the service).
 */
async function offeredTools(dir: string, context: McpContext, ticket: string | undefined): Promise<{ tools: OfferedTool[]; writes: boolean }> {
	const offline = { tools: [], writes: ticket !== undefined || new LocalWritesSetting(dir).enabled() };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), REMOTE_LIST_WAIT_MS);
	});
	try {
		const answer = (await Promise.race([callControl(dir, "POST", "/mcp/tools", ticket ? { ticket } : {}), timeout])) as {
			tools?: OfferedTool[];
			unavailable?: { group: string; reason: string }[];
			writes?: boolean;
		} | null;
		if (!answer) {
			context.log("Chat and Localman tools left out: tunelo did not list them in time");
			return offline;
		}
		for (const gap of answer.unavailable ?? []) context.log(redactMessage(`${gap.group} tools left out: ${gap.reason}`));
		return { tools: answer.tools ?? [], writes: answer.writes === true };
	} catch (err) {
		context.log(redactMessage(`Chat and Localman tools left out: ${err instanceof Error ? err.message : String(err)}`));
		return offline;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `tunelo mcp`: MCP server over stdio, e.g. `claude mcp add tunelo -- tunelo mcp`.
 * It answers `initialize` and `tools/list` by itself (the Chat and Localman
 * tools when the service names them) and runs every tool in the background
 * service, which holds the sign-in; without the service a call says to
 * start it. Tunnels it opened close when this process ends. Started by a
 * claude session of tunelo, it carries that session's ticket.
 */
export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Run an MCP server (stdio) with tunelo's tools: tunnels, Chat, Localman")
		.option("--server <url>", "Tunnel server URL")
		.action(async (options: { server?: string }) => {
			const dir = configDir();
			const serverUrl = resolveServerUrl(options.server, printServerMigration);
			const context = createMcpContext(serverUrl, dir);
			const ticket = process.env[TICKET_ENV] || undefined;
			const session = new ServiceSession(dir, serverUrl, ticket);
			const server = new McpServer({ name: "tunelo", version: AGENT_VERSION });

			const forward = async (
				group: string,
				tool: string,
				args: ToolArgs,
			): Promise<CallToolResult> => {
				try {
					const id = await session.id();
					const result = await callControl(dir, "POST", "/mcp/call", {
						session: id,
						group,
						tool,
						args,
					});
					if (!isToolResult(result)) {
						throw new Error("tunelo answered something else than a tool result");
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return failure(
						new Error(message.startsWith("tunelo is not running") ? NOT_RUNNING : redactMessage(message)),
					);
				}
			};

			// A client that may not write does not see write tools (the service refuses them anyway).
			const offered = await offeredTools(dir, context, ticket);
			if (!offered.writes) context.log(LOCAL_WRITES_OFF);

			// The tunnel tools come from the same table the service runs.
			for (const group of TOOL_GROUPS) {
				if (!group.register) continue;
				const table = new ToolTable();
				group.register(table, { context, tunnels: new LocalTunnels(context) });
				for (const [name, config] of table.entries()) {
					if (!offered.writes && group.writeTools.includes(name)) continue;
					const { title, description, annotations, inputSchema } = config;
					if (inputSchema) {
						server.registerTool(
							name,
							{ title, description, inputSchema, ...(annotations ? { annotations } : {}) },
							(args: ToolArgs) => forward(group.name, name, args),
						);
					} else {
						server.registerTool(
							name,
							{ title, description, ...(annotations ? { annotations } : {}) },
							() => forward(group.name, name, {}),
						);
					}
				}
			}

			for (const tool of offered.tools) {
				server.registerTool(
					tool.exposed,
					{
						...(tool.title ? { title: tool.title } : {}),
						description: tool.description,
						inputSchema: advertisedSchema(tool.inputSchema),
						...(tool.annotations ? { annotations: tool.annotations } : {}),
					},
					(args: ToolArgs) => forward(tool.group, tool.name, args),
				);
			}

			let exiting = false;
			const shutdown = (): void => {
				if (exiting) return;
				exiting = true;
				session.close();
				void server.close().finally(() => process.exit(0));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			process.stdin.on("end", shutdown);

			const transport = new StdioServerTransport();
			transport.onclose = shutdown;
			await server.connect(transport);
			context.log(`ready (server ${serverUrl})`);
		});
}
