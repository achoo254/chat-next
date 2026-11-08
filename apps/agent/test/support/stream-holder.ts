// A `tunelo http` stand-in: asks the service for a tunnel and holds the
// stream until killed. Prints each event as a JSON line.
import { configDir } from "../../src/config.ts";
import { streamControl } from "../../src/control-socket.ts";

const [server = "", port = "0"] = process.argv.slice(2);
await streamControl(configDir(), "/tunnels/open", { kind: "http", server, tunnels: [{ port: Number(port) }] }, (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
});
