#!/usr/bin/env node
// chat-agent: lets the user's own devices drive the AI coding CLI installed
// on this machine, end-to-end encrypted.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { ConfigStore, configDir } from "./config.ts";
import { callControl, serveControl } from "./control-socket.ts";
import { machineKey } from "./keystore.ts";
import { registerMachine } from "./machine-api.ts";
import { Machine } from "./machine.ts";
import { goOnline } from "./online.ts";
import { installService, uninstallService } from "./service.ts";
import { signIn } from "./tunnel.ts";
import { update } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";

const HELP = `chat-agent ${AGENT_VERSION}

Usage:
  chat-agent install <code> --trust <device key>
                                   register this machine (pairing secret on stdin),
                                   sign in to the tunnel and start at login
  chat-agent login                 sign in to the tunnel again
  chat-agent uninstall             stop starting at login
  chat-agent update                install the newest signed release and restart
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
      const port = await machine.start(portArg ? Number(portArg) : undefined);
      const stopControl = serveControl(machine);
      const offline = goOnline(machine, port, (l) => console.log(l));
      const shutdown = async () => {
        offline();
        stopControl();
        await machine.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      return new Promise(() => undefined);
    }
    case "install": {
      const code = args[0] ?? "";
      const trust = flag(args, "--trust") ?? "";
      if (!/^[A-Za-z0-9_-]{22}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(trust)) throw new Error("usage: chat-agent install <code> --trust <device key>");
      const secret = (await readLine()).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("the pairing secret must come on stdin");
      const config = new ConfigStore(dir);
      const key = await machineKey(dir);
      const reg = await registerMachine(code, key.publicKey, AGENT_VERSION);
      config.update((c) => {
        c.machineId = reg.machineId;
        c.machineSecret = reg.machineSecret;
        c.install = { deviceKey: trust, secret };
      });
      console.log("Registered. Now allow the tunnel sign-in in your browser.");
      await login(dir);
      const where = await installService(dir);
      console.log(`chat-agent will start at login (${where}). You can close this window.`);
      return 0;
    }
    case "login":
      await login(dir);
      return 0;
    case "update": {
      const v = await update((l) => console.log(l));
      if (!v) {
        console.log(`chat-agent ${AGENT_VERSION} is the newest.`);
        return 0;
      }
      // The service supervisor (launchd / logon task loop) starts the new file.
      await callControl(dir, "POST", "/restart").catch(() => undefined);
      console.log(`Updated to ${v}.`);
      return 0;
    }
    case "uninstall":
      await uninstallService(dir);
      console.log("chat-agent no longer starts at login. Remove the machine on the web to forget it there.");
      return 0;
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

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (l) => {
      rl.close();
      resolve(l);
    });
    rl.once("close", () => resolve(""));
  });
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], () => undefined);
}

async function login(dir: string): Promise<void> {
  await signIn(dir, (a) => {
    const url = a.verificationUriComplete ?? a.verificationUri;
    console.log(`Open ${url} and confirm code ${a.userCode}`);
    openBrowser(url);
  });
  console.log("Signed in.");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`chat-agent: ${err.message}`);
    process.exit(1);
  },
);
