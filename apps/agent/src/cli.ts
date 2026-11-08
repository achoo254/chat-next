#!/usr/bin/env node
// chat-agent: lets the user's own devices drive the AI coding CLI installed
// on this machine, end-to-end encrypted.
import { ConfigStore, configDir } from "./config.ts";
import { callControl, serveControl } from "./control-socket.ts";
import { Machine } from "./machine.ts";
import { AGENT_VERSION } from "./version.ts";

const HELP = `chat-agent ${AGENT_VERSION}

Usage:
  chat-agent run [--port N]        start the agent in the foreground
  chat-agent pair                  show a QR payload and 6-digit code to pair a device
  chat-agent status                show machine, AI and session status
  chat-agent devices               list paired devices
  chat-agent devices revoke <key>  revoke a paired device (first characters of its key)
  chat-agent audit                 show the consent log
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const dir = configDir();
  switch (cmd) {
    case "run": {
      const machine = new Machine({ config: new ConfigStore(dir) });
      const portArg = flag(args, "--port");
      await machine.start(portArg ? Number(portArg) : undefined);
      const stopControl = serveControl(machine);
      const shutdown = async () => {
        stopControl();
        await machine.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      return new Promise(() => undefined);
    }
    case "pair": {
      const p = (await callControl(dir, "POST", "/pair")) as { code: string; qr: string; expiresAt: number };
      console.log(`Pairing code: ${p.code.slice(0, 3)} ${p.code.slice(3)}`);
      console.log(`QR payload:   ${p.qr}`);
      console.log(`Valid until ${new Date(p.expiresAt).toLocaleTimeString()}; 5 attempts.`);
      return 0;
    }
    case "status":
    case "audit":
      console.log(JSON.stringify(await callControl(dir, "GET", `/${cmd}`), null, 2));
      return 0;
    case "devices":
      if (args[0] === "revoke") {
        console.log(JSON.stringify(await callControl(dir, "POST", "/devices/revoke", { key: args[1] ?? "" })));
      } else {
        console.log(JSON.stringify(await callControl(dir, "GET", "/devices"), null, 2));
      }
      return 0;
    case "--version":
    case "version":
      console.log(AGENT_VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`chat-agent: ${err.message}`);
    process.exit(1);
  },
);
