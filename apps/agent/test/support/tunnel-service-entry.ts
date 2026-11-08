// The background service with only its tunnel and MCP side (no chat machine),
// for tests that drive it from other real processes (node or bun).
import { writeFileSync } from "node:fs";
import { configDir } from "../../src/config.ts";
import { serveControl } from "../../src/control-socket.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { TunnelService } from "../../src/tunnels/tunnel-service.ts";

const dir = configDir();
const tunnels = new TunnelService(dir);
// Tests point the Chat and Localman tools at fake servers, with fixed tokens.
const remoteApps = process.env.TUNELO_TEST_REMOTE_APPS;
const remote = remoteApps ? fakeRemote(JSON.parse(remoteApps) as Record<string, { url: string; token: string }>) : undefined;
const mcp = new McpHost(dir, remote ? { remote } : {});
// Tests that act as a claude session of tunelo read its ticket here.
if (process.env.TUNELO_TEST_TICKET_FILE) writeFileSync(process.env.TUNELO_TEST_TICKET_FILE, mcp.tickets.issue("test-session"), { mode: 0o600 });

function fakeRemote(apps: Record<string, { url: string; token: string }>): RemoteProxy {
	const app = (name: string) => {
		const found = apps[name];
		if (!found) throw new Error(`no fake ${name}`);
		return found;
	};
	return new RemoteProxy({
		endpoint: (name) => app(name).url,
		token: async (name) => app(name).token,
		forget: async () => undefined,
		account: () => "test",
	});
}
const timeout = Number(process.env.TUNELO_TEST_STREAM_TIMEOUT_MS);
const stop = serveControl({ dir, tunnels, mcp }, timeout > 0 ? { streamTimeoutMs: timeout } : {});
process.on("SIGTERM", () => {
	tunnels.closeAll("closed because tunelo stopped");
	mcp.endAll();
	stop();
	process.exit(0);
});
