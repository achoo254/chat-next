// pm2 processes of the chat API on the shared server, running as the system
// user `chat`; each binary reads its env file itself. `chat-api` serves the
// primary tenant (/opt/chat/.env); every /opt/chat/tenants/<id>.env
// (setup-tenant.sh) adds `chat-api-<id>`: the same release on the same
// database, for another tenant. The realtime WebSocket gateway (/ws) runs
// inside each process, so there is no separate gateway process to manage.
const fs = require("node:fs");
const path = require("node:path");

const TENANTS = "/opt/chat/tenants";

function app(name, envFile, log) {
	return {
		name,
		script: "/opt/chat/current/server",
		args: `-role api -env-file ${envFile}`,
		interpreter: "none",
		cwd: "/opt/chat",
		uid: "chat",
		gid: "chat",
		instances: 1,
		exec_mode: "fork",
		// Photos are decoded in-process within a 256 MiB budget
		// (server/README.md, Media); GOMEMLIMIT makes the Go GC return
		// that memory before pm2's cap is near.
		max_memory_restart: "700M",
		env: { GOMEMLIMIT: "450MiB" },
		// Above the server's graceful shutdown budget (67 s, server/README.md).
		kill_timeout: 70000,
		out_file: `/var/log/chat/${log}.out.log`,
		error_file: `/var/log/chat/${log}.err.log`,
		merge_logs: true,
		time: true,
	};
}

function tenantApps() {
	let files = [];
	try {
		files = fs
			.readdirSync(TENANTS)
			.filter((file) => /^[a-z][a-z0-9]{1,30}\.env$/.test(file))
			// A tenant starts once its OIDC client secret is in (setup-tenant.sh).
			.filter((file) => /^OIDC_CLIENT_SECRET=./m.test(fs.readFileSync(path.join(TENANTS, file), "utf8")));
	} catch {
		return [];
	}
	return files.sort().map((file) => {
		const id = file.slice(0, -".env".length);
		return app(`chat-api-${id}`, path.join(TENANTS, file), `api-${id}`);
	});
}

module.exports = {
	apps: [app("chat-api", "/opt/chat/.env", "api"), ...tenantApps()],
};
