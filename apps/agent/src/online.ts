// Puts the machine online: its place in Chat (registration-status.ts adds it
// to the signed-in account), and once it has one, the machine tunnel, a
// heartbeat every minute (and whenever the tunnel address changes, or a
// device the machine does not know yet shakes hands), the account's trusted
// devices from each heartbeat, removal from the web, "needs you" pushes and
// usage hint pushes.
//
// Chat, Localman and the tunnel fail apart: a heartbeat, registration or
// Localman link that fails only changes that app's state, and the tunnel
// keeps running. The tunnel tells the machine whether its server gates
// Localman's requests for localhost (tunnels/forward.ts).
import { identitySession } from "./identity/session.ts";
import { LocalmanLink, deviceIdOf } from "./localman/self-link.ts";
import { MachineApiError, heartbeat, notifyNeedsInput, notifyUsageHint, registerMachine } from "./machine-api.ts";
import type { Machine } from "./machine.ts";
import { Registration } from "./registration-status.ts";
import { TUNNEL_SERVER, isSignedIn, openTunnel } from "./tunnel.ts";
import { AGENT_VERSION } from "./version.ts";

const HEARTBEAT_MS = 60_000;

export type Online = {
  registration: Registration;
  stop: () => void;
};

export function goOnline(m: Machine, localPort: number, log: (l: string) => void): Online {
  let stopMachine: (() => void) | undefined;
  const session = identitySession(m.config.dir);
  const localman = new LocalmanLink({
    config: m.config,
    session,
    tunnelServer: TUNNEL_SERVER,
    forward: () => m.localForward.state(),
    log,
  });
  const online = () => {
    stopMachine ??= machineOnline(m, localPort, registration, log, () => (stopMachine = undefined));
  };
  const registration = new Registration({
    config: m.config,
    session,
    api: { register: registerMachine },
    machineKey: () => m.keyPair,
    agentVersion: AGENT_VERSION,
    onRegistered: () => {
      online();
      localman.start();
    },
    localman,
    log,
  });
  const c = m.config.get();
  // A machine with a place in Chat opens its tunnel at once.
  if (c.machineId && c.machineSecret) online();
  registration.start();
  localman.start();
  return {
    registration,
    stop: () => {
      registration.stop();
      localman.stop();
      stopMachine?.();
    },
  };
}

/**
 * The tunnel and heartbeat of a registered machine. The machine secret is
 * read from the config at every call: registering again (after `tunelo
 * login`) gives a new one. `onRemoved` hears that the owner removed the
 * machine on the web (everything here has stopped then).
 */
function machineOnline(m: Machine, localPort: number, registration: Registration, log: (l: string) => void, onRemoved: () => void): () => void {
  const machineId = m.config.get().machineId;
  if (!m.config.get().machineSecret || !machineId) return () => undefined;
  const secret = (): string => m.config.get().machineSecret ?? "";
  if (!isSignedIn(m.config.dir)) {
    log("tunnel sign-in missing: run `tunelo login`");
    registration.setTunnel({ status: "sign-in", detail: "run `tunelo login`" });
  }

  let tunnelUrl = "";
  let stopped = false;
  let closeTunnel: () => void = () => undefined;

  m.setNotify((thread, pending) => {
    notifyNeedsInput(secret(), { kind: "approval", pendingCount: pending, sessionId: thread.id }).catch((e: Error) => log(`push failed: ${e.message}`));
  });
  // A chat server without usage hint pushes refuses the kind: not asked again until tunelo restarts.
  let usagePushRefused = false;
  m.setNotifyUsage(async () => {
    if (usagePushRefused) throw new Error("the chat server does not send usage hint pushes");
    try {
      await notifyUsageHint(secret());
    } catch (err) {
      if (err instanceof MachineApiError && err.code === "invalid_argument") usagePushRefused = true;
      throw err;
    }
  });

  const stop = (why: string) => {
    if (stopped) return;
    stopped = true;
    m.trust.setRefresh(undefined);
    closeTunnel();
    m.localForward.tunnelDisconnected();
    clearInterval(timer);
    log(why);
  };

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const info = await m.machineInfo();
      const r = await heartbeat(secret(), {
        tunnelUrl,
        agentVersion: AGENT_VERSION,
        claudeVersion: info.providers[0]?.version ?? "",
        connectedDeviceKeys: m.connectedDeviceKeys(),
      });
      if (r.revoked) {
        stop("this machine was removed on the web; tunnel closed");
        m.leftAccount();
        registration.removed();
        registration.setTunnel({ status: "off", detail: "closed: the machine was removed on the web" });
        onRemoved();
        return;
      }
      registration.tunnelListed(!r.tunnelRefused);
      m.applyTrustedDevices(r.trustedDevices);
    } catch (err) {
      if (err instanceof MachineApiError && err.reason === "agent_update_required") {
        stop("this tunelo is too old for the server: run the install command on the chat's Machines page again");
        onRemoved();
        return;
      }
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  };
  // A device the machine does not know yet asks Chat at once (device-trust.ts limits how often).
  m.trust.setRefresh(beat);

  closeTunnel = openTunnel(
    { dir: m.config.dir, localPort, deviceId: deviceIdOf(machineId) },
    {
      onUrl: (url, features) => {
        tunnelUrl = url;
        m.localForward.tunnelConnected(url, features);
        registration.setTunnel({ status: "ok", detail: `online at ${url}` });
        log(`online at ${url}`);
        void beat();
      },
      onDown: () => m.localForward.tunnelDisconnected(),
      onFatal: (code, message) => {
        tunnelUrl = "";
        registration.setTunnel({ status: "error", detail: `refused (${code}): ${message}` });
        log(`tunnel refused (${code}): ${message}`);
        void beat();
      },
      log,
    },
  );
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref?.();
  void beat();
  return () => stop("offline");
}
