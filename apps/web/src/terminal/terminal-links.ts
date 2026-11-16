// One terminal link per machine for the hub's lifetime, shared by the dock
// and the path pill of the session header. Kept apart from the dock so the
// pill can show on every view without loading xterm.
import { brand } from "../brand.ts";
import type { LinkHub } from "../machines/link/link-hub.ts";
import { browserPeers, defaultIceServers, TerminalLink } from "./terminal-link.ts";

const linksOfHub = new WeakMap<LinkHub, Map<string, TerminalLink>>();

/** STUN servers: VITE_TERMINAL_STUN ("host:port,host:port", "" for none) or the relay's own. */
function iceServers(): { urls: string }[] {
	const configured = import.meta.env.VITE_TERMINAL_STUN;
	if (configured === undefined) return defaultIceServers(brand.domain);
	return configured
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[A-Za-z0-9.-]+:[0-9]{1,5}$/.test(s))
		.slice(0, 4)
		.map((s) => ({ urls: `stun:${s}` }));
}

export function terminalLinkFor(hub: LinkHub, ref: string): TerminalLink {
	let links = linksOfHub.get(hub);
	if (links === undefined) {
		links = new Map();
		linksOfHub.set(hub, links);
	}
	let link = links.get(ref);
	if (link === undefined) {
		link = new TerminalLink({ carrier: hub.terminalCarrier(ref), peers: browserPeers(), iceServers: iceServers() });
		links.set(ref, link);
	}
	return link;
}
