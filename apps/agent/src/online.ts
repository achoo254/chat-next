// Puts a registered machine online: the tunnel, a heartbeat every minute
// (and whenever the tunnel address changes), revocations from the web, and
// "needs you" pushes.
import { MachineApiError, heartbeat, notifyNeedsInput, toUrl64 } from "./machine-api.ts";
import type { Machine } from "./machine.ts";
import { isSignedIn, openTunnel } from "./tunnel.ts";
import { AGENT_VERSION } from "./version.ts";

const HEARTBEAT_MS = 60_000;

export function goOnline(m: Machine, localPort: number, log: (l: string) => void): () => void {
  const c = m.config.get();
  const secret = c.machineSecret;
  if (!secret || !c.machineId) {
    log("not registered with a chat account yet: run the command from the web page (tunelo install)");
    return () => undefined;
  }
  if (!isSignedIn(m.config.dir)) {
    log("tunnel sign-in missing: run `tunelo login`");
    return () => undefined;
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
        m.config.update((x) => {
          delete x.machineSecret;
          delete x.machineId;
        });
        return stop("this machine was removed on the web; tunnel closed");
      }
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
      if (err instanceof MachineApiError && /agent_update_required/.test(err.message)) {
        return stop("this tunelo is too old for the server: run `tunelo update`");
      }
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  };

  closeTunnel = openTunnel(
    { dir: m.config.dir, localPort, deviceId: `chat-agent.${c.machineId}`, ...(c.subdomain ? { subdomain: c.subdomain } : {}) },
    {
      onUrl: (url, subdomain) => {
        tunnelUrl = url;
        if (subdomain && subdomain !== m.config.get().subdomain) m.config.update((x) => (x.subdomain = subdomain));
        log(`online at ${url}`);
        void beat();
      },
      onFatal: (code, message) => {
        tunnelUrl = "";
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

