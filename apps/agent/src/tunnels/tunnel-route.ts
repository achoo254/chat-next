/**
 * Where a terminal's `tunelo http|tcp` runs its tunnel. With the account
 * session and the background service running, the service opens it (only
 * the service refreshes the session) and streams the events back; the
 * tunnel closes when this terminal goes. Otherwise (no service, or a fixed
 * `--key` / `TUNELO_KEY`) this process opens it, with the session read from
 * disk under the session lock.
 */
import { configDir } from "../config.ts";
import { deviceInfo } from "../identity/cli-settings.ts";
import type { Credential } from "../identity/credentials.ts";
import { controlAnswers, streamControl } from "../control-socket.ts";
import { type TunnelEvent, type TunnelSpec, hostTunnel } from "./tunnel-host.ts";

export interface TerminalTunnel {
	/** "service" when the background service holds it. */
	via: "service" | "here";
	close(): void;
}

const SERVICE_GONE = "tunelo stopped in the background, so the tunnel closed. Start it again with `tunelo start`.";

function isEvent(message: unknown): message is TunnelEvent {
	return typeof message === "object" && message !== null && typeof (message as { type?: unknown }).type === "string";
}

export async function openTerminalTunnel(
	spec: TunnelSpec,
	credential: Credential,
	onEvent: (event: TunnelEvent) => void,
	dir: string = configDir(),
): Promise<TerminalTunnel> {
	if (credential.kind === "account" && (await controlAnswers(dir))) {
		let ended = false;
		let closing = false;
		const stream = await streamControl(dir, "/tunnels/open", spec, (message) => {
			if (!isEvent(message)) return;
			if (message.type === "failed" || message.type === "closed") ended = true;
			onEvent(message);
		});
		void stream.done.then(() => {
			if (!ended && !closing) onEvent({ type: "failed", message: SERVICE_GONE });
		});
		return {
			via: "service",
			close() {
				closing = true;
				stream.close();
			},
		};
	}
	const hosted = hostTunnel(spec, credential, deviceInfo(dir), onEvent);
	return { via: "here", close: () => hosted.close() };
}
