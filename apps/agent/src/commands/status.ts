// `tunelo status`: the version, the account, where the machine stands with
// Chat, the tunnel and Localman, the background service, when Chat last
// listed the account's devices, and the tunnels running here. Exits 1 when
// the background service does not answer (the Windows restart loop and the
// install scripts rely on it). With `--json`, or when the output goes to a
// program, the service's status as JSON (the install scripts read
// `fullDiskAccess` from it) with the account and the apps added.
import { ConfigStore, configDir } from "../config.ts";
import { callControl, controlPid } from "../control-socket.ts";
import { AGENT_CLIENT_ID, identitySession } from "../identity/session.ts";
import { type AppsReport, describeApps, storedReport } from "../registration-status.ts";
import { diskAccessSteps } from "../safety/disk-access.ts";
import { tunnelRunLines } from "../tunnels/cli-status-commands.ts";
import { printServerMigration, resolveServerUrl } from "../tunnels/server-url.ts";
import { describeWhoAmI, whoAmI } from "../tunnels/whoami.ts";
import { AGENT_VERSION } from "../version.ts";

type ServiceStatus = Record<string, unknown> & { fullDiskAccess?: unknown; registered?: unknown; trustSyncedAt?: unknown; trustedDevices?: unknown };

/** "3 min ago", for when Chat last listed the devices. */
export function ago(at: number, now = Date.now()): string {
  if (at <= 0) return "never";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 120) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The lines about the machine itself, from the running service's status. */
export function machineLines(service: ServiceStatus | undefined, pid: string): string[] {
  if (!service) return ["Background service: not running (`tunelo login` starts it)"];
  const name = typeof service.name === "string" ? service.name : "";
  const synced = typeof service.trustSyncedAt === "number" ? service.trustSyncedAt : 0;
  const devices = typeof service.trustedDevices === "number" ? service.trustedDevices : 0;
  return [
    `Background service: running${pid}`,
    `Machine: ${name}${service.registered === true ? "" : " (not in AI Agent yet)"}`,
    `Devices of the account: ${devices}, last listed by Chat ${ago(synced)}`,
  ];
}

export async function status(options: { json?: boolean }): Promise<number> {
  const dir = configDir();
  const session = identitySession(dir);
  const info = session.info();
  let service: ServiceStatus | undefined;
  let apps: AppsReport;
  try {
    service = (await callControl(dir, "GET", "/status")) as ServiceStatus;
    apps = (await callControl(dir, "GET", "/apps")) as AppsReport;
  } catch {
    apps = storedReport(new ConfigStore(dir), session);
  }
  const account = info ? { issuer: info.issuer, sub: info.sub } : null;

  if (options.json || process.stdout.isTTY !== true) {
    // Scripts wait for this to succeed: no service, nothing on stdout.
    if (!service) {
      console.error("tunelo is not running in the background (`tunelo login` starts it)");
      return 1;
    }
    console.log(JSON.stringify({ ...service, version: AGENT_VERSION, account, apps }, null, 2));
    return 0;
  }

  console.log(`tunelo ${AGENT_VERSION}`);
  try {
    console.log(describeWhoAmI(await whoAmI(resolveServerUrl(undefined, printServerMigration), dir)));
  } catch (err) {
    console.log(`Account: ${info?.sub ?? "not signed in"} (could not reach the tunnel server: ${(err as Error).message})`);
  }
  if (info && info.clientId !== AGENT_CLIENT_ID) console.log("This sign-in covers the tunnel only: run `tunelo login` once for Chat and Localman too.");
  for (const line of describeApps(apps)) console.log(line);
  const servicePid = service ? controlPid(dir) : undefined;
  const pid = servicePid ? ` (pid ${servicePid})` : "";
  for (const line of machineLines(service, pid)) console.log(line);
  console.log("");
  for (const line of tunnelRunLines()) console.log(line);
  if (service) {
    const held = (await callControl(dir, "GET", "/tunnels").catch(() => ({ mcp: [] }))) as { mcp?: { id: string; protocol: string; url: string; localPort: number }[] };
    for (const t of held.mcp ?? []) console.log(`MCP ${t.id}  [${t.protocol}]  ${t.url} → :${t.localPort}`);
    if (service.fullDiskAccess === "needed") {
      console.log("");
      for (const line of diskAccessSteps(process.execPath, false)) console.log(line);
    }
  }
  return service ? 0 : 1;
}
