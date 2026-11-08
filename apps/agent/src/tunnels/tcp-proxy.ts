/** TCP proxy — connects to local TCP services and relays data via WS */

import net from "node:net";
import type {
	TcpConnectionClose,
	TcpConnectionOpen,
	TcpDataMessage,
	TunnelClient,
} from "@tunelo/client";

interface LocalTcpConnection {
	socket: net.Socket;
	connectionId: string;
}

export class TcpProxy {
	private connections = new Map<string, LocalTcpConnection>();
	private readonly client: TunnelClient;
	private readonly localPort: number;
	private readonly localHost: string;

	constructor(
		client: TunnelClient,
		localPort: number,
		localHost = "127.0.0.1",
	) {
		this.client = client;
		this.localPort = localPort;
		this.localHost = localHost;
		this.setupHandlers();
	}

	private setupHandlers(): void {
		this.client.on("tcp-connection-open", (msg: TcpConnectionOpen) => {
			this.handleConnectionOpen(msg);
		});

		this.client.on("tcp-data", (msg: TcpDataMessage) => {
			this.handleData(msg);
		});

		this.client.on("tcp-connection-close", (msg: TcpConnectionClose) => {
			this.handleConnectionClose(msg);
		});
	}

	private handleConnectionOpen(msg: TcpConnectionOpen): void {
		const localSocket = net.createConnection({
			host: this.localHost,
			port: this.localPort,
		});

		const conn: LocalTcpConnection = {
			socket: localSocket,
			connectionId: msg.connectionId,
		};
		this.connections.set(msg.connectionId, conn);

		// Forward local data to server via WS
		localSocket.on("data", (chunk: Buffer) => {
			this.client.sendMsg({
				type: "tcp-data",
				connectionId: msg.connectionId,
				data: chunk.toString("base64"),
			});
		});

		localSocket.on("close", () => {
			this.connections.delete(msg.connectionId);
			this.client.sendMsg({
				type: "tcp-connection-close",
				connectionId: msg.connectionId,
			});
		});

		localSocket.on("error", () => {
			localSocket.destroy();
			this.connections.delete(msg.connectionId);
			this.client.sendMsg({
				type: "tcp-connection-close",
				connectionId: msg.connectionId,
			});
		});
	}

	private handleData(msg: TcpDataMessage): void {
		const conn = this.connections.get(msg.connectionId);
		if (conn) {
			conn.socket.write(Buffer.from(msg.data, "base64"));
		}
	}

	private handleConnectionClose(msg: TcpConnectionClose): void {
		const conn = this.connections.get(msg.connectionId);
		if (conn) {
			conn.socket.destroy();
			this.connections.delete(msg.connectionId);
		}
	}

	close(): void {
		for (const [, conn] of this.connections) {
			conn.socket.destroy();
		}
		this.connections.clear();
	}
}
