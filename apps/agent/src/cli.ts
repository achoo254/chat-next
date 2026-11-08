#!/usr/bin/env node
// tunelo: lets the user's own devices drive the AI coding CLI installed
// on this machine, end-to-end encrypted. Started under its earlier name hda
// (the bridge release replaces the hda file), it moves the install to
// tunelo instead (migrate-from-hda.ts).
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ConfigStore, configDir, legacyConfigDir } from "./config.ts";
import { callControl, controlPid, serveControl } from "./control-socket.ts";
import { machineKey } from "./keystore.ts";
import { registerMachine } from "./machine-api.ts";
import { Machine } from "./machine.ts";
import { logFile, tailLog } from "./log-tail.ts";
import {
  finishMigration,
  hasLegacyInstall,
  isMigrated,
  migrateFromHda,
  migrationPaths,
  osMigrationSystem,
  removeLegacyBinaries,
  runAsHda,
} from "./migrate-from-hda.ts";
import { goOnline } from "./online.ts";
import { installService, isCompiled, startService, stopService, uninstallService } from "./service.ts";
import { signIn } from "./tunnel.ts";
import { update } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";

const HELP = `tunelo ${AGENT_VERSION}

Usage:
  tunelo install <code> --trust <device key>
                                      register this machine (pairing secret on stdin),
                                      sign in to the tunnel and start at login
  tunelo login                 sign in to the tunnel again
  tunelo start                 run in the background (keeps running after the terminal closes)
  tunelo stop                  stop the background agent until tunelo start or the next login
  tunelo uninstall             stop starting at login
  tunelo update                install the newest signed release and restart
  tunelo run [--port N]        run in this terminal only (closing it stops tunelo)
  tunelo pair                  show a QR payload and 6-digit code to pair a device
  tunelo status                show machine, AI and session status
  tunelo logs [-n N] [-f]      show the last N lines of the log (50); -f keeps following it
  tunelo devices               list paired devices
  tunelo devices revoke <key>  revoke a paired device (first characters of its key)
  tunelo audit                 show the consent log
  tunelo trust [dir]           let a folder's own .claude settings load (default: current folder)
  tunelo untrust [dir]         stop loading that folder's .claude settings
  tunelo trusted               list trusted folders
  tunelo migrate-from-hda      move an install of hda (the earlier name) to tunelo
`;

const log = (line: string) => console.log(line);

/** The pid of the agent answering on the control channel, or null when none does. */
async function runningPid(dir: string): Promise<number | null> {
  try {
    await callControl(dir, "GET", "/status");
  } catch {
    return null;
  }
  return controlPid(dir) ?? 0;
}

async function waitRunning(dir: string, ms: number): Promise<number | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    const pid = await runningPid(dir);
    if (pid !== null) return pid;
  }
  return null;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Runs the agent in this process until it is stopped. Refuses while an agent
 * answers in this folder or in the folder of the other name (hda's before the
 * move, tunelo's after it), so one machine never runs two.
 */
async function runAgent(dir: string, args: string[]): Promise<number> {
  for (const d of new Set([resolve(dir), resolve(configDir()), resolve(legacyConfigDir())])) {
    const running = await runningPid(d);
    if (running !== null) throw new Error(`tunelo is already running (pid ${running}, ${d}); \`tunelo stop\` stops it`);
  }
  const machine = new Machine({ config: new ConfigStore(dir) });
  const portArg = flag(args, "--port");
  const port = await machine.start(portArg ? Number(portArg) : undefined);
  const stopControl = serveControl(machine);
  const offline = goOnline(machine, port, log);
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

/** `tunelo migrate-from-hda` (the install scripts run it when they find hda). */
async function migrateCommand(): Promise<number> {
  if (!isCompiled()) throw new Error("run this from the installed tunelo binary, not from the sources");
  const paths = migrationPaths();
  if (!hasLegacyInstall(paths.legacyDir)) {
    console.log("No hda install found; nothing to move.");
    return 0;
  }
  const sys = osMigrationSystem();
  if (isMigrated(paths.legacyDir)) await finishMigration(paths, sys, log);
  else await migrateFromHda(paths, sys, log);
  const pid = await waitRunning(paths.newDir, 60_000);
  console.log(pid === null ? "Moved to tunelo; it is starting, check `tunelo status` in a moment." : `Moved to tunelo; it runs in the background (pid ${pid}).`);
  return 0;
}

/** The same command through the tunelo binary; its exit code. */
function forward(exe: string, argv: string[]): number {
  const r = spawnSync(exe, argv, { stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/**
 * Started as hda: `run` comes from hda's supervisor and moves the install;
 * once moved, every other command goes to tunelo.
 */
async function hdaMain(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "--version" || cmd === "version") {
    console.log(AGENT_VERSION);
    return 0;
  }
  const paths = migrationPaths();
  if (cmd === "run") return runAsHda(paths, osMigrationSystem(), log, () => runAgent(paths.legacyDir, args));
  if (isMigrated(paths.legacyDir) && existsSync(paths.newExe)) {
    console.error(`hda is now called tunelo; running \`tunelo ${argv.join(" ")}\`.`);
    return forward(paths.newExe, argv);
  }
  throw new Error(
    "hda is being renamed to tunelo. The move finishes when the background process starts again; or run the install command from the Chat page (My machines) again.",
  );
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const dir = configDir();
  switch (cmd) {
    case "run":
      return runAgent(dir, args);
    case "migrate-from-hda":
      return migrateCommand();
    case "install": {
      const code = args[0] ?? "";
      const trust = flag(args, "--trust") ?? "";
      if (!/^[A-Za-z0-9_-]{22}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(trust)) throw new Error("usage: tunelo install <code> --trust <device key>");
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
      console.log(`tunelo will start at login (${where}). You can close this window.`);
      return 0;
    }
    case "login":
      await login(dir);
      return 0;
    case "update": {
      const v = await update((l) => console.log(l));
      if (!v) {
        console.log(`tunelo ${AGENT_VERSION} is the newest.`);
        return 0;
      }
      // The service supervisor (launchd / logon task loop) starts the new file.
      await callControl(dir, "POST", "/restart").catch(() => undefined);
      console.log(`Updated to ${v}.`);
      return 0;
    }
    case "start": {
      const running = await runningPid(dir);
      if (running !== null) {
        console.log(`tunelo is already running in the background (pid ${running}).`);
      } else {
        await startService(dir);
        const pid = await waitRunning(dir, 30_000);
        console.log(pid === null ? "tunelo is starting; check `tunelo status` in a moment." : `tunelo is running in the background (pid ${pid}). You can close this terminal.`);
      }
      removeLegacyBinaries(legacyConfigDir());
      return 0;
    }
    case "stop":
      await stopService(dir);
      console.log("tunelo stopped. `tunelo start` starts it again; it also starts at the next login.");
      return 0;
    case "logs": {
      const n = Number(flag(args, "-n") ?? 50);
      const follow = args.includes("-f") || args.includes("--follow");
      const stop = new AbortController();
      process.on("SIGINT", () => stop.abort());
      await tailLog(logFile(dir), { lines: Number.isFinite(n) ? n : 50, follow, write: (s) => process.stdout.write(s), signal: stop.signal });
      return 0;
    }
    case "uninstall":
      await uninstallService(dir);
      console.log("tunelo no longer starts at login. Remove the machine on the web to forget it there.");
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
    case "trust":
    case "untrust":
      console.log(JSON.stringify(await callControl(dir, "POST", "/trust", { dir: args[0] ?? process.cwd(), trusted: cmd === "trust" ? "true" : "false" })));
      return 0;
    case "trusted":
      console.log(JSON.stringify(await callControl(dir, "GET", "/trust"), null, 2));
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

const asHda = basename(process.execPath).replace(/\.exe$/i, "").toLowerCase() === "hda";

(asHda ? hdaMain : main)(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`${asHda ? "hda" : "tunelo"}: ${err.message}`);
    process.exit(1);
  },
);
