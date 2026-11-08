// The WebSocket to a machine's tunnel, as the link code sees it: a browser
// WebSocket in the app, a fake in the tests.
import { brand } from "../../brand.ts";

export interface SocketLike {
	binaryType: BinaryType;
	onopen: (() => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: (() => void) | null;
	send(data: Uint8Array<ArrayBuffer>): void;
	close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

const STEP_TIMEOUT_MS = 15_000;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A machine's tunnel: wss://<subdomain>.tunnel.<domain>, nothing else. */
const TUNNEL = new RegExp(`^wss://[a-z0-9-]+\\.tunnel\\.${escapeRegExp(brand.domain)}/?$`);
/** The agent on this computer, for development only (`hda run --port N`). */
const LOCAL = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/;

/** Whether the app may open `url` as a machine's tunnel. */
export function allowedTunnel(url: string, dev: boolean = import.meta.env.DEV): boolean {
	if (TUNNEL.test(url)) return true;
	const local = dev ? LOCAL.exec(url) : null;
	return local !== null && Number(local[1]) > 0 && Number(local[1]) < 65536;
}

/** Binary frame data from a message event; null for text frames. */
export function frameBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (data instanceof Uint8Array) return new Uint8Array(data);
	return null;
}

/**
 * A socket opened for a short exchange (pairing, the install handshake):
 * messages queue until read, each read times out.
 */
export interface Exchange {
	send(data: Uint8Array<ArrayBuffer>): void;
	next(): Promise<Uint8Array<ArrayBuffer>>;
	close(): void;
}

export function openExchange(factory: SocketFactory, url: string): Promise<Exchange> {
	if (!allowedTunnel(url)) return Promise.reject(new Error("not a machine tunnel address"));
	return new Promise((resolve, reject) => {
		const socket = factory(url);
		socket.binaryType = "arraybuffer";
		const queue: Uint8Array<ArrayBuffer>[] = [];
		let waiting: { resolve: (data: Uint8Array<ArrayBuffer>) => void; reject: (err: Error) => void } | null = null;
		let closed: Error | null = null;
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error("the machine did not answer"));
		}, STEP_TIMEOUT_MS);
		socket.onmessage = (event) => {
			const bytes = frameBytes(event.data);
			if (bytes === null) return;
			if (waiting !== null) {
				const w = waiting;
				waiting = null;
				w.resolve(bytes);
			} else queue.push(bytes);
		};
		socket.onclose = (event) => {
			closed = new Error(`connection closed (${event.code})`);
			clearTimeout(timer);
			reject(closed);
			if (waiting !== null) waiting.reject(closed);
			waiting = null;
		};
		socket.onerror = () => undefined;
		socket.onopen = () => {
			clearTimeout(timer);
			resolve({
				send: (data) => socket.send(data),
				close: () => socket.close(1000),
				next: () => {
					const ready = queue.shift();
					if (ready !== undefined) return Promise.resolve(ready);
					if (closed !== null) return Promise.reject(closed);
					return new Promise((ok, fail) => {
						const t = setTimeout(() => {
							waiting = null;
							fail(new Error("the machine did not answer"));
						}, STEP_TIMEOUT_MS);
						waiting = {
							resolve: (data) => {
								clearTimeout(t);
								ok(data);
							},
							reject: (err) => {
								clearTimeout(t);
								fail(err);
							},
						};
					});
				},
			});
		};
	});
}
