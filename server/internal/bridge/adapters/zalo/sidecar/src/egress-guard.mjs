// In-process egress guard: whatever a library or a server response asks for, this process
// connects only to *.zalo.me and to the few exact Zalo hosts named below. It wraps the one place every outgoing connection passes through
// (net.Socket#connect: http, https, tls and ws all end there), so it holds without knowing
// the library's internals. It also refuses unix sockets (`ws+unix:`) and IP literals.
// The firewall around the process is the second layer; this is the one that knows names.
import net from "node:net";

const ALLOWED = /(^|\.)zalo\.me$/i;
// Exact hosts outside zalo.me that the login flow is redirected to. Each is one host, never a domain:
// jr.zaloapp.com is where the library's session check ends up after a QR login (seen on a real login).
const EXTRA_HOSTS = new Set(["jr.zaloapp.com"]);

/** Where a Socket#connect call goes: a host name, or a unix path. */
export function targetOf(args) {
	// net.connect() and tls.connect() hand Socket#connect an already normalised array: [options, callback].
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (first !== null && typeof first === "object") {
		if (typeof first.path === "string") return { path: first.path };
		return { host: String(first.host ?? "localhost") };
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first }; // connect(path)
	return { host: typeof args[1] === "string" ? args[1] : "localhost" }; // connect(port[, host])
}

/** Whether a connection target is allowed. */
export function isAllowed(target) {
	if (target.path !== undefined) return false;
	const host = target.host ?? "";
	if (net.isIP(host) !== 0) return false;
	return ALLOWED.test(host) || EXTRA_HOSTS.has(host.toLowerCase());
}

/**
 * Installs the guard. `onHost` is told each allowed host name once (the learning run of the
 * firewall reads them from stderr); `onBlocked` is told each refused target.
 */
export function installEgressGuard({ onHost = () => {}, onBlocked = () => {} } = {}) {
	const seen = new Set();
	const original = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function guardedConnect(...args) {
		const target = targetOf(args);
		if (!isAllowed(target)) {
			onBlocked(target);
			const error = new Error("connection refused by the egress guard");
			error.code = "EGRESS_BLOCKED";
			process.nextTick(() => this.destroy(error));
			return this;
		}
		if (!seen.has(target.host)) {
			seen.add(target.host);
			onHost(target.host);
		}
		return original.apply(this, args);
	};
	return () => {
		net.Socket.prototype.connect = original;
	};
}
