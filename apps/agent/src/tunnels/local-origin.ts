/**
 * The local server of `tunelo http` (the request inspector) answers only this
 * machine's own pages. A request must name a loopback host (so a DNS
 * rebinding page, whose Host is its own name, is refused), and a browser
 * request must come from that same origin (so another site cannot read the
 * requests that went through the tunnel or replay into the local app). Node
 * clients such as `tunelo watch` send no Origin and pass.
 */
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/i;

export function isLocalRequest(req: Pick<IncomingMessage, "headers">): boolean {
	const host = req.headers.host ?? "";
	if (!LOOPBACK_HOST.test(host)) return false;
	const origin = req.headers.origin;
	return origin === undefined || origin.toLowerCase() === `http://${host.toLowerCase()}`;
}
