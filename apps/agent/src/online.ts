// Puts the machine online: its place in Chat (registration-status.ts adds or
// claims it with the signed-in account), and once it has one, the machine
// tunnel, a heartbeat every minute (and whenever the tunnel address
// changes), revocations from the web and "needs you" pushes.
//
// Chat and the tunnel fail apart: a heartbeat or registration that fails only
// changes Chat's state, and the tunnel keeps running.
import { identitySession } from "./identity/session.ts";
import { MachineApiError, claimMachine, heartbeat, notifyNeedsInput, registerMachine, toUrl64 } from "./machine-api.ts";
import type { Machine } from "./machine.ts";
import { Registration } from "./registration-status.ts";
import { isSignedIn, openTunnel } from "./tunnel.ts";
import { AGENT_VERSION } from "./version.ts";

const HEARTBEAT_MS = 60_000;

export type Online = {
  registration: Registration;
  stop: () => void;
};

export function goOnline(m: Machine, localPort: number, log: (l: string) => void): Online {
  let stopMachine: (() => void) | undefined;
  const registration = new Registration({
    config: m.config,
    session: identitySession(m.config.dir),
    api: { register: registerMachine, claim: claimMachine },
    publicKey: () => m.publicKey,
    agentVersion: AGENT_VERSION,
    onRegistered: () => {
      stopMachine ??= machineOnline(m, localPort, registration, log);
    },
    log,
  });
  const c = m.config.get();
  // A machine with a place in Chat opens its tunnel at once, claimed or not.
  if (c.machineId && c.machineSecret) stopMachine = machineOnline(m, localPort, registration, log);
  registration.start();
  return {
    registration,
    stop: () => {
      registration.stop();
      stopMachine?.();
    },
  };
}

function machineOnline(m: Machine, localPort: number, registration: Registration, log: (l: string) => void): () => void {
  const c = m.config.get();
  const secret = c.machineSecret;
  const machineId = c.machineId;
  if (!secret || !machineId) return () => undefined;
  if (!isSignedIn(m.config.dir)) {
    log("tunnel sign-in missing: run `tunelo login`");
    registration.setTunnel({ status: "sign-in", detail: "run `tunelo login`" });
  }

  let tunnelUrl = "";
  let stopped = false;
  let closeTunnel: () => void = () => undefined;

  m.setNotify((thread, pending) => {
    notifyNeedsInput(secret, { kind: "approval", pendingCount: pending, sessionId: thread.id }).catch((e: Error) => log(`push failed: ${e.message}`));
  });

  const stop = (why: string) => {
    if (stopped) return;
    stopped = true;
    closeTunnel();
    clearInterval(timer);
    log(why);
  };

  const beat = async () => {
    if (stopped) return;
    try {
      const info = await m.machineInfo();
      const r = await heartbeat(secret, { tunnelUrl, agentVersion: AGENT_VERSION, claudeVersion: info.providers[0]?.version ?? "" });
      if (r.revoked) {
        registration.removed();
        registration.setTunnel({ status: "off", detail: "closed: the machine was removed on the web" });
        return stop("this machine was removed on the web; tunnel closed");
      }
      if (r.claimed) registration.claimConfirmed();
      else registration.claimNeeded();
      for (const std of r.revokedDeviceKeys ?? []) {
        const key = toUrl64(std);
        if (m.config.deviceStatus(Uint8Array.from(atob(std), (ch) => ch.charCodeAt(0))) === "paired") {
          m.config.revokeDevice(key);
          m.dropDevice(key);
          m.audit.write({ device: "web", action: "revoke", path: "", detail: key.slice(0, 12) });
          log(`device ${key.slice(0, 8)} revoked from the web`);
        }
      }
    } catch (err) {
      if (err instanceof MachineApiError && err.reason === "agent_update_required") {
        return stop("this tunelo is too old for the server: run `tunelo update`");
      }
      if (err instanceof MachineApiError && err.reason === "tunnel_not_owned") {
        registration.chatRefused("Chat refused the tunnel: it was opened with another account; run `tunelo login` with the machine's account");
      }
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  };

  closeTunnel = openTunnel(
    { dir: m.config.dir, localPort, deviceId: `chat-agent.${machineId}`, ...(c.subdomain ? { subdomain: c.subdomain } : {}) },
    {
      onUrl: (url, subdomain) => {
        tunnelUrl = url;
        if (subdomain && subdomain !== m.config.get().subdomain) m.config.update((x) => (x.subdomain = subdomain));
        registration.setTunnel({ status: "ok", detail: `online at ${url}` });
        log(`online at ${url}`);
        void beat();
      },
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
