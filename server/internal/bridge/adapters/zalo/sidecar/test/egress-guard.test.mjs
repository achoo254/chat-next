import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { installEgressGuard, isAllowed, targetOf } from "../src/egress-guard.mjs";

test("one exact host outside zalo.me is allowed, and nothing around it", () => {
	assert.equal(isAllowed({ host: "jr.zaloapp.com" }), true);
	assert.equal(isAllowed({ host: "JR.ZALOAPP.COM" }), true);
	for (const host of ["zaloapp.com", "x.jr.zaloapp.com", "chat.zaloapp.com", "jr.zaloapp.com.evil.com", "jr.zaloapp.com."]) assert.equal(isAllowed({ host }), false, host);
});

test("only zalo.me and its subdomains are allowed", () => {
	for (const host of ["zalo.me", "chat.zalo.me", "ws2-msg.chat.zalo.me", "WPA.CHAT.ZALO.ME"]) assert.equal(isAllowed({ host }), true, host);
	for (const host of ["evil.com", "zalo.me.evil.com", "notzalo.me", "registry.npmjs.org", "localhost", "", "zalo.me.", "xzalo.me"]) {
		assert.equal(isAllowed({ host }), false, host);
	}
});

test("IP literals and unix sockets are refused", () => {
	assert.equal(isAllowed({ host: "10.0.0.1" }), false);
	assert.equal(isAllowed({ host: "::1" }), false);
	assert.equal(isAllowed({ path: "/var/run/docker.sock" }), false);
});

test("the target is read from every form of connect()", () => {
	assert.deepEqual(targetOf([{ host: "chat.zalo.me", port: 443 }]), { host: "chat.zalo.me" });
	assert.deepEqual(targetOf([{ path: "/tmp/x.sock" }]), { path: "/tmp/x.sock" });
	assert.deepEqual(targetOf([443, "chat.zalo.me"]), { host: "chat.zalo.me" });
	assert.deepEqual(targetOf(["/tmp/x.sock"]), { path: "/tmp/x.sock" });
	assert.deepEqual(targetOf([8080]), { host: "localhost" });
	// What net.connect() passes on: an array marked as normalised.
	assert.deepEqual(targetOf([[{ host: "chat.zalo.me", port: 443 }, null]]), { host: "chat.zalo.me" });
});

test("a refused connection fails before anything leaves the process", async () => {
	const blocked = [];
	const uninstall = installEgressGuard({ onBlocked: (target) => blocked.push(target) });
	try {
		await assert.rejects(
			new Promise((resolve, reject) => {
				const socket = net.connect({ host: "example.com", port: 80 });
				socket.on("connect", resolve);
				socket.on("error", reject);
			}),
			{ code: "EGRESS_BLOCKED" },
		);
		assert.deepEqual(blocked, [{ host: "example.com" }]);
	} finally {
		uninstall();
	}
});

test("allowed host names are reported once", () => {
	const hosts = [];
	const uninstall = installEgressGuard({ onHost: (host) => hosts.push(host) });
	try {
		for (let i = 0; i < 2; i++) {
			const socket = net.connect({ host: "chat.zalo.me", port: 1 });
			socket.on("error", () => {});
			socket.destroy();
		}
	} finally {
		uninstall();
	}
	assert.deepEqual(hosts, ["chat.zalo.me"]);
});
