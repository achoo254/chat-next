// The account's device list as a heartbeat would deliver it, for tests that
// connect a device: trusting a key adds it to the stored list (synced now),
// revoking drops it (the machine then answers REVOKED).
import { toBase64Url } from "@achoo254/chat-remote-protocol";
import type { ConfigStore } from "../../src/config.ts";

export function trustDevice(config: ConfigStore, key: Uint8Array, name = "device"): void {
  const k = toBase64Url(key);
  const list = (config.get().trustedDevices?.list ?? []).filter((d) => d.key !== k);
  config.syncTrustedDevices([...list, { key: k, name, platform: "web", createdAt: Date.now() }]);
}

export function revokeDevice(config: ConfigStore, key: Uint8Array | string): void {
  const k = typeof key === "string" ? key : toBase64Url(key);
  config.syncTrustedDevices((config.get().trustedDevices?.list ?? []).filter((d) => d.key !== k));
}
