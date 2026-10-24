// Platform pieces available inside the web worker. What only the main
// thread can do (visibility, notifications) arrives or leaves as messages.
import type { Lifecycle, SocketFactory, Unsubscribe } from "@achoo254/chat-platform";

/** Binary WebSocket for the realtime gateway; the HttpOnly session cookie rides along. */
export const webSocketFactory: SocketFactory = (url, handlers) => {
	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	socket.onopen = () => handlers.onOpen();
	socket.onmessage = (event: MessageEvent) => {
		// realtime.proto frames are binary; anything else is not ours.
		if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
	};
	socket.onclose = (event: CloseEvent) => handlers.onClose(event.code, event.reason);
	return {
		// WebSocket.send takes views over ArrayBuffer only (not SharedArrayBuffer).
		send: (data) =>
			socket.send(
				data.buffer instanceof ArrayBuffer
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: data.slice(),
			),
		close: (code, reason) => socket.close(code, reason),
	};
};

/** Lifecycle fed by the tabs: foreground when any tab is visible. */
export class RelayedLifecycle implements Lifecycle {
	private foreground: boolean;
	private readonly foregroundListeners = new Set<(foreground: boolean) => void>();
	private readonly onlineListeners = new Set<() => void>();

	constructor(foreground: boolean) {
		this.foreground = foreground;
	}

	isForeground(): boolean {
		return this.foreground;
	}

	onForegroundChange(listener: (foreground: boolean) => void): Unsubscribe {
		this.foregroundListeners.add(listener);
		return () => this.foregroundListeners.delete(listener);
	}

	onOnline(listener: () => void): Unsubscribe {
		this.onlineListeners.add(listener);
		return () => this.onlineListeners.delete(listener);
	}

	setForeground(foreground: boolean): void {
		if (foreground === this.foreground) return;
		this.foreground = foreground;
		for (const listener of this.foregroundListeners) listener(foreground);
	}

	reportOnline(): void {
		for (const listener of this.onlineListeners) listener();
	}
}
