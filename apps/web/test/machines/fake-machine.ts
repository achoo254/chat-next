// A machine (agent side) behind fake WebSockets for the link tests: it runs
// the real handshake and sealed frames of @achoo254/chat-remote-protocol,
// records what the device sent, and answers through a scriptable handler.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FrameSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { acceptHello, equal, generateKeyPair, type KeyPair, type Session } from "@achoo254/chat-remote-protocol";
import type { SocketLike } from "../../src/machines/link/socket.ts";

type FrameValue<K> = Extract<Frame["body"], { case: K }> extends { value: infer V } ? V : never;

export type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

export class FakeSocket implements SocketLike {
	binaryType: BinaryType = "blob";
	onopen: (() => void) | null = null;
	onmessage: ((event: { readonly data: unknown }) => void) | null = null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	session: Session | null = null;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		readonly url: string,
		private readonly machine: FakeMachine,
	) {}

	send(data: Uint8Array<ArrayBuffer>): void {
		const copy = new Uint8Array(data);
		this.chain = this.chain.then(() => this.machine.receive(this, copy));
	}

	close(): void {
		this.closed = true;
	}

	/** The machine side sends raw bytes. */
	deliver(bytes: Uint8Array): void {
		if (this.closed) return;
		this.onmessage?.({ data: bytes.slice().buffer });
	}

	/** The connection drops (relay gone, machine asleep). */
	drop(): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.({ code: 1006, reason: "" });
	}
}

export class FakeMachine {
	readonly sockets: FakeSocket[] = [];
	readonly received: Frame[] = [];
	/** Device keys the account lists for this machine. */
	trusted: Uint8Array[] = [];
	/** Device keys the account revoked. */
	revoked: Uint8Array[] = [];
	/** Answers a request; return nothing to stay silent. */
	handler: (frame: Frame, socket: FakeSocket) => Body[] | undefined = (frame) => defaultAnswer(frame);
	/** URLs the factory refuses (closes before open). */
	readonly unreachable = new Set<string>();

	private constructor(readonly keys: KeyPair) {}

	static async create(): Promise<FakeMachine> {
		return new FakeMachine(await generateKeyPair());
	}

	get socket(): FakeSocket {
		const last = this.sockets.at(-1);
		if (last === undefined) throw new Error("no socket yet");
		return last;
	}

	readonly factory = (url: string): SocketLike => {
		const socket = new FakeSocket(url, this);
		this.sockets.push(socket);
		setTimeout(() => {
			if (this.unreachable.has(url)) socket.drop();
			else socket.onopen?.();
		}, 0);
		return socket;
	};

	async receive(socket: FakeSocket, bytes: Uint8Array): Promise<void> {
		if (socket.closed) return;
		if (socket.session === null) {
			const result = await acceptHello(bytes, {
				machine: this.keys,
				deviceStatus: (key) => (this.trusted.some((p) => equal(p, key)) ? "trusted" : this.revoked.some((p) => equal(p, key)) ? "revoked" : "unknown"),
			});
			socket.deliver(result.reply);
			if (result.ok) socket.session = result.session;
			else socket.drop();
			return;
		}
		const frame = socket.session.open(bytes);
		this.received.push(frame);
		for (const body of this.handler(frame, socket) ?? []) this.send(socket, body, frame.id);
	}

	send(socket: FakeSocket, body: Body, id = ""): void {
		if (socket.session === null) throw new Error("no session");
		socket.deliver(socket.session.seal(create(FrameSchema, { id, body })));
	}

	/** Requests of one kind the device sent, in order. */
	sent<K extends NonNullable<Frame["body"]["case"]>>(kind: K): FrameValue<K>[] {
		return this.received.filter((f) => f.body.case === kind).map((f) => f.body.value) as unknown as FrameValue<K>[];
	}
}

export function defaultAnswer(frame: Frame): Body[] | undefined {
	switch (frame.body.case) {
		case "ping":
			return [{ case: "pong", value: {} }];
		case "machineInfoRequest":
			return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", providers: [{ id: "claude", name: "Claude Code" }], maxSessions: 3 } }];
		case "threadList":
			return [{ case: "threadListResult", value: { threads: [], openSessions: 0, maxSessions: 3 } }];
		case "threadSubscribe":
			return [{ case: "threadItems", value: { threadId: frame.body.value.threadId, items: [], cursor: frame.body.value.cursor } }];
		default:
			return [{ case: "ack", value: {} }];
	}
}

/** Waits until `check` passes (or fails after a second). */
export async function until(check: () => boolean, what = "condition"): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}
