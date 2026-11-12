// `tunelo logout`: this machine leaves the account. It is removed from the
// account's machines in Chat (UnregisterMachine, with the machine secret),
// its link to Localman is revoked on the tunnel server, the background
// service stops and no longer starts at login, the account's sign-in is
// revoked at the IdP, and the machine's place, trusted devices and tokens
// are forgotten. The binary and the machine key stay: a later `tunelo login`
// adds the machine back.
//
// The calls to Chat and the tunnel server come first, while nothing local has
// changed: when one cannot be made (no network), nothing changes and the
// error says so; `--force` then forgets the machine on this side only.
import { ConfigStore } from "../config.ts";
import { updateSettings } from "../identity/cli-settings.ts";
import { ResourceNotGrantedError, SessionExpiredError, identitySession } from "../identity/session.ts";
import { deviceIdOf } from "../localman/self-link.ts";
import { MachineApiError, unregisterMachine } from "../machine-api.ts";
import { uninstallService } from "../service.ts";
import { TUNNEL_SERVER } from "../tunnel.ts";
import { ApiClientError, getApiBaseUrl, listLinks, revokeLink } from "../tunnels/api-client.ts";

/** What leaving touches outside the config; tests replace it. */
export interface LogoutDeps {
  unregister: (machineSecret: string) => Promise<unknown>;
  /** The account's access token for the tunnel server; rejects when the sign-in no longer opens. */
  tunnelToken: (dir: string) => Promise<string>;
  listLinks: (token: string) => Promise<{ id: string; deviceId?: string }[]>;
  revokeLink: (token: string, id: string) => Promise<void>;
  /** Stops the service and removes its start at login (the terminal process too). */
  removeService: (dir: string) => Promise<void>;
  /** Revokes the sign-in at the IdP and deletes it here; null when there was none. */
  signOut: (dir: string) => Promise<{ issuer: string; revokeError?: Error } | null>;
  /** Forgets an anonymous tunnel token saved by an older CLI; true when there was one. */
  forgetLegacyKey: (dir: string) => boolean;
  log: (line: string) => void;
}

export const defaultLogoutDeps: LogoutDeps = {
  unregister: (secret) => unregisterMachine(secret),
  tunnelToken: (dir) => identitySession(dir).getAppToken("tunnel"),
  listLinks: (token) => listLinks(getApiBaseUrl(TUNNEL_SERVER), token),
  revokeLink: (token, id) => revokeLink(getApiBaseUrl(TUNNEL_SERVER), token, id),
  removeService: (dir) => uninstallService(dir),
  signOut: (dir) => identitySession(dir).signOut(),
  forgetLegacyKey: (dir) => {
    let hadKey = false;
    updateSettings((settings) => {
      hadKey = settings.key !== undefined;
      return { ...settings, key: undefined };
    }, dir);
    return hadKey;
  },
  log: (line) => console.log(line),
};

/** A step that could not be done now; with `--force` the rest goes on. */
class LeaveError extends Error {}

/** The sign-in cannot give a token any more: nothing at the tunnel server can be reached with it. */
function signInGone(err: unknown): boolean {
  return err instanceof SessionExpiredError || err instanceof ResourceNotGrantedError;
}

async function leaveChat(secret: string | undefined, deps: LogoutDeps): Promise<void> {
  if (!secret) return;
  try {
    await deps.unregister(secret);
    deps.log("  Removed this machine from your account in Chat.");
  } catch (err) {
    // A secret Chat no longer takes: the machine was removed already.
    if (err instanceof MachineApiError && (err.code === "unauthenticated" || err.code === "not_found")) return;
    throw new LeaveError(`could not remove this machine in Chat (${(err as Error).message})`);
  }
}

async function leaveLocalman(dir: string, machineId: string | undefined, deps: LogoutDeps): Promise<void> {
  if (!machineId) return;
  let token: string;
  try {
    token = await deps.tunnelToken(dir);
  } catch (err) {
    if (signInGone(err)) {
      deps.log("  The sign-in no longer opens, so Localman's link to this machine stays until you remove it in Localman (Settings › Tunelo).");
      return;
    }
    throw new LeaveError(`could not reach the sign-in (${(err as Error).message})`);
  }
  const deviceId = deviceIdOf(machineId);
  try {
    const links = (await deps.listLinks(token)).filter((l) => l.deviceId === deviceId);
    for (const link of links) {
      await deps.revokeLink(token, link.id).catch((err: unknown) => {
        // Revoked meanwhile.
        if (err instanceof ApiClientError && err.statusCode === 404) return;
        throw err;
      });
    }
    if (links.length > 0) deps.log("  Removed this machine from Localman.");
  } catch (err) {
    throw new LeaveError(`could not remove this machine from Localman (${(err as Error).message})`);
  }
}

/**
 * Leaves the account. Resolves with the exit code; without `force`, a step
 * that needs the network and fails leaves everything as it was (1).
 * `force`: those steps only warn, and the machine is forgotten here anyway.
 */
export async function logout(dir: string, opts: { force: boolean }, deps: LogoutDeps = defaultLogoutDeps): Promise<number> {
  const config = new ConfigStore(dir);
  const { machineId, machineSecret } = config.get();
  for (const step of [() => leaveChat(machineSecret, deps), () => leaveLocalman(dir, machineId, deps)]) {
    try {
      await step();
    } catch (err) {
      if (!(err instanceof LeaveError)) throw err;
      if (!opts.force) {
        deps.log(`  ${err.message}. Nothing was changed; try again once online, or \`tunelo logout --force\` to forget this machine here only.`);
        return 1;
      }
      deps.log(`  Warning: ${err.message}; going on (--force). Remove the machine on the chat's Machines page.`);
    }
  }

  await deps.removeService(dir).catch((err: unknown) => deps.log(`  Warning: could not stop the background service (${(err as Error).message}).`));
  const signedOut = await deps.signOut(dir);
  if (signedOut?.revokeError) {
    deps.log(`  Could not revoke the sign-in at ${signedOut.issuer} (${signedOut.revokeError.message}); revoke this machine at ${signedOut.issuer}/account.`);
  }
  const hadKey = deps.forgetLegacyKey(dir);
  // The service is stopped: nothing else writes the config now.
  config.update((c) => {
    delete c.machineId;
    delete c.machineSecret;
    delete c.trustedDevices;
    delete c.localman;
    delete c.machineRemoved;
  });
  if (!signedOut && !hadKey && !machineId) {
    deps.log("  Not signed in.");
    return 0;
  }
  deps.log("  Signed out. This machine left your account; `tunelo login` adds it again.");
  return 0;
}
