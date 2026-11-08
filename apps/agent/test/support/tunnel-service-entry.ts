// The background service with only its tunnel and MCP side (no chat machine),
// for tests that drive `tunelo mcp` against a real second process.
import { configDir } from "../../src/config.ts";
import { serveControl } from "../../src/control-socket.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { TunnelService } from "../../src/tunnels/tunnel-service.ts";

const dir = configDir();
const tunnels = new TunnelService(dir);
const mcp = new McpHost(dir);
const stop = serveControl({ dir, tunnels, mcp });
process.on("SIGTERM", () => {
	tunnels.closeAll("closed because tunelo stopped");
	mcp.endAll();
	stop();
	process.exit(0);
});
