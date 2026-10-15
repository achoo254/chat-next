// pm2 process of the chat API on the shared server. One instance (stage 1),
// running as the system user `chat`; the binary reads /opt/chat/.env itself.
// The realtime WebSocket gateway (/ws) runs inside this process, so there is
// no separate gateway process to manage.
module.exports = {
	apps: [
		{
			name: "chat-api",
			script: "/opt/chat/current/server",
			args: "-role api -env-file /opt/chat/.env",
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
			out_file: "/var/log/chat/api.out.log",
			error_file: "/var/log/chat/api.err.log",
			merge_logs: true,
			time: true,
		},
	],
};
