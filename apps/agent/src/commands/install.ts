// `tunelo install --trust <device key>`, run by the install script that the
// Chat page "Add this machine" shows: keeps the pairing secret (stdin only)
// for the first handshake of that browser, signs in with the account
// (`tunelo login`: tunnel, Chat and Localman at once) and starts the
// background service at login. The service then adds the machine to the
// account's "My machines" by itself; no install code is involved. The
// pairing stays end to end: the secret never leaves this machine.
import type { Command } from "commander";
import { ConfigStore, configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { machineKey } from "../keystore.ts";
import { installService, stopService } from "../service.ts";
import { TUNNEL_SERVER } from "../tunnel.ts";
import { signInForServer } from "../tunnels/cli-login-command.js";

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** First line of stdin. The installer pipes exactly one line and closes it. */
async function readLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += Buffer.from(chunk as Uint8Array).toString("utf8");
    if (data.includes("\n")) break;
  }
  // PowerShell may prefix piped text with a byte order mark.
  return (data.split(/\r?\n/)[0] ?? "").replace(/^\uFEFF/, "");
}

async function isRunning(dir: string): Promise<boolean> {
  return callControl(dir, "GET", "/status").then(
    () => true,
    () => false,
  );
}

async function install(options: { trust?: string }): Promise<number> {
  const dir = configDir();
  const trust = options.trust ?? "";
  if (!KEY_RE.test(trust)) throw new Error("usage: tunelo install --trust <device key> (pairing secret on stdin)");
  const secret = (await readLine()).trim();
  if (!KEY_RE.test(secret)) throw new Error("the pairing secret must come on stdin");

  // The running service owns the config: stop it before changing it.
  if (await isRunning(dir)) {
    await stopService(dir);
    for (const end = Date.now() + 15_000; Date.now() < end && (await isRunning(dir)); ) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await machineKey(dir);
  // "Add this machine" adds a new machine, as each install always did: the
  // service registers it again, and the browser that showed the command
  // pairs through the secret.
  new ConfigStore(dir).update((c) => {
    c.install = { deviceKey: trust, secret };
    delete c.machineId;
    delete c.machineSecret;
    delete c.claimed;
    delete c.machineRemoved;
  });
  await signInForServer(TUNNEL_SERVER);
  console.log("Signed in.");
  const where = await installService(dir);
  console.log(`tunelo will start at login (${where}); this machine appears in My machines in a moment. You can close this window.`);
  return 0;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("add this machine to My machines: sign in, pair the browser that showed the command (secret on stdin), start at login")
    .requiredOption("--trust <device key>", "the device that pairs first")
    .action(async (options: { trust?: string }) => process.exit(await install(options)));
}
