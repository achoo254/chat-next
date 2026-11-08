/**
 * Tunnels the background service holds for `tunelo http` / `tunelo tcp`
 * terminals: opened with the service's own session (so only the service
 * refreshes it), alive while the terminal stays connected to the control
 * socket, closed when it disconnects or `tunnel.close` names it.
 */
import { randomUUID } from "node:crypto";
import { NO_CREDENTIAL_MESSAGE, resolveCredential } from "../identity/credentials.ts";
import { deviceInfo } from "../identity/cli-settings.ts";
import { type HostedTunnel, type TunnelEvent, type TunnelSpec, hostTunnel } from "./tunnel-host.ts";

export interface HeldTunnel {
	id: string;
	kind: TunnelSpec["kind"];
	/** Public URLs, once the server granted them. */
	urls: string[];
	localPorts: number[];
	openedAt: string;
}

interface Entry {
	info: HeldTunnel;
	hosted: HostedTunnel;
	emit: (event: TunnelEvent) => void;
}

export class TunnelService {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly dir: string) {}

	/** Opens a tunnel; `emit` hears its events until it closes. Returns its id. */
	open(spec: TunnelSpec, emit: (event: TunnelEvent) => void): string {
		const id = randomUUID().slice(0, 8);
		const info: HeldTunnel = {
			id,
			kind: spec.kind,
			urls: [],
			localPorts: spec.kind === "http" ? spec.tunnels.map((t) => t.port) : [spec.port],
			openedAt: new Date().toISOString(),
		};
		const credential = resolveCredential(undefined, spec.server, this.dir);
		if (!credential) {
			emit({ type: "failed", message: NO_CREDENTIAL_MESSAGE });
			return id;
		}
		const relay = (event: TunnelEvent): void => {
			if (event.type === "connected" || event.type === "tunnel-registered" || event.type === "tcp-registered") {
				if (!info.urls.includes(event.url)) info.urls.push(event.url);
			}
			if (event.type === "failed") this.entries.delete(id);
			emit(event);
		};
		const hosted = hostTunnel(spec, credential, deviceInfo(this.dir), relay);
		this.entries.set(id, { info, hosted, emit });
		return id;
	}

	list(): HeldTunnel[] {
		return [...this.entries.values()].map((entry) => entry.info);
	}

	/** Closes one tunnel and tells its terminal why; false when none has that id. */
	close(id: string, reason = "closed by `tunelo`"): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		this.entries.delete(id);
		entry.hosted.close();
		entry.emit({ type: "closed", reason });
		return true;
	}

	closeAll(reason: string): void {
		for (const id of [...this.entries.keys()]) this.close(id, reason);
	}
}
