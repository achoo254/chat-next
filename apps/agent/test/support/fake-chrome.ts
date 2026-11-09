// A browser's DevTools endpoint for the tunelo browser tests: flat sessions,
// tabs, a screencast that sends one picture when it starts, input and
// WebAuthn commands recorded as they come, and events the test fires (a
// page asking for a passkey, a test passkey made).
import { type Server, createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { BrowserLauncher } from "../../src/remote-browser/remote-browser.ts";

export interface Call {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

interface Tab {
	targetId: string;
	url: string;
	title: string;
}

/** A tiny valid JPEG is not needed: the bytes only travel. */
export const PICTURE = Buffer.from("fake-jpeg-picture");

export class FakeChrome {
	readonly calls: Call[] = [];
	readonly tabs = new Map<string, Tab>();
	passwordFocused = false;
	launched = 0;
	cleared = 0;
	private server!: Server;
	private wss!: WebSocketServer;
	private socket: WebSocket | undefined;
	private port = 0;
	private serial = 0;
	private running = false;

	async start(): Promise<void> {
		this.wss = new WebSocketServer({ noServer: true });
		this.server = createServer((_req, res) => res.writeHead(404).end());
		this.server.on("upgrade", (req, socket, head) => this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws)));
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
		this.port = (this.server.address() as { port: number }).port;
		this.addTab("https://example.com/", "Example");
	}

	stop(): void {
		this.socket?.close();
		this.wss.close();
		this.server.close();
	}

	readonly launcher: BrowserLauncher = {
		available: () => true,
		running: async () => (this.running ? this.endpoint() : undefined),
		launch: async () => {
			this.launched += 1;
			this.running = true;
			return this.endpoint();
		},
		clear: async () => {
			this.cleared += 1;
		},
	};

	private endpoint() {
		return { port: this.port, wsUrl: `ws://127.0.0.1:${this.port}/devtools/browser/fake`, headless: true };
	}

	addTab(url: string, title = ""): Tab {
		const tab = { targetId: `T${++this.serial}`, url, title };
		this.tabs.set(tab.targetId, tab);
		return tab;
	}

	called(method: string): Call[] {
		return this.calls.filter((c) => c.method === method);
	}

	/** The browser closes (the user quit it). */
	quit(): void {
		this.running = false;
		this.socket?.close();
	}

	/** A page's script calls the passkey binding. */
	passkeyWanted(targetId: string, kind: "create" | "get"): void {
		this.event("Runtime.bindingCalled", { name: "__tuneloPasskeyWanted", payload: kind }, `S${targetId}`);
	}

	/** A test passkey was made in a tab. */
	credentialAdded(targetId: string, credentialId: string): void {
		this.event("WebAuthn.credentialAdded", { authenticatorId: `A${targetId}`, credential: { credentialId, privateKey: "k" } }, `S${targetId}`);
	}

	private event(method: string, params: object, sessionId?: string): void {
		this.socket?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
	}

	private info(tab: Tab) {
		return { targetId: tab.targetId, type: "page", url: tab.url, title: tab.title, attached: false };
	}

	private accept(ws: WebSocket): void {
		this.socket = ws;
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
			this.calls.push({ method: msg.method, params: msg.params, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
			const reply = (result: object) => ws.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
			const tabOf = () => this.tabs.get(String(msg.sessionId ?? "").slice(1));
			switch (msg.method) {
				case "Target.getTargets":
					return reply({ targetInfos: [...this.tabs.values()].map((t) => this.info(t)) });
				case "Target.attachToTarget":
					return reply({ sessionId: `S${String(msg.params.targetId)}` });
				case "Target.createTarget": {
					const tab = this.addTab(String(msg.params.url));
					this.event("Target.targetCreated", { targetInfo: this.info(tab) });
					return reply({ targetId: tab.targetId });
				}
				case "Target.getTargetInfo": {
					const tab = this.tabs.get(String(msg.params.targetId));
					return tab ? reply({ targetInfo: this.info(tab) }) : ws.send(JSON.stringify({ id: msg.id, error: { message: "no target" } }));
				}
				case "Page.navigate": {
					const tab = tabOf();
					if (tab) {
						tab.url = String(msg.params.url);
						this.event("Target.targetInfoChanged", { targetInfo: this.info(tab) });
					}
					return reply({ frameId: "f" });
				}
				case "Page.startScreencast":
					reply({});
					return this.event("Page.screencastFrame", { data: PICTURE.toString("base64"), metadata: { deviceWidth: 1200, deviceHeight: 800 }, sessionId: 1 }, msg.sessionId);
				case "Runtime.evaluate":
					return reply({ result: { type: "boolean", value: this.passwordFocused } });
				case "WebAuthn.addVirtualAuthenticator":
					return reply({ authenticatorId: `A${String(msg.sessionId).slice(1)}` });
				case "Browser.close":
					reply({});
					this.running = false;
					return ws.close();
				default:
					return reply({});
			}
		});
	}
}
