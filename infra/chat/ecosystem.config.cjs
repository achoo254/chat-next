// pm2 process of the chat API on the shared server. One instance (stage 1),
// running as the system user `chat`; the binary reads /opt/chat/.env itself.
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
			max_memory_restart: "300M",
			kill_timeout: 10000,
			out_file: "/var/log/chat/api.out.log",
			error_file: "/var/log/chat/api.err.log",
			merge_logs: true,
			time: true,
		},
	],
};
