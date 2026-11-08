// The background service with only its tunnel and MCP side (no chat machine),
// for tests that drive it from other real processes (node or bun).
import { configDir } from "../../src/config.ts";
import { serveControl } from "../../src/control-socket.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { TunnelService } from "../../src/tunnels/tunnel-service.ts";

const dir = configDir();
const tunnels = new TunnelService(dir);
const mcp = new McpHost(dir);
const timeout = Number(process.env.TUNELO_TEST_STREAM_TIMEOUT_MS);
const stop = serveControl({ dir, tunnels, mcp }, timeout > 0 ? { streamTimeoutMs: timeout } : {});
process.on("SIGTERM", () => {
	tunnels.closeAll("closed because tunelo stopped");
	mcp.endAll();
	stop();
	process.exit(0);
});
