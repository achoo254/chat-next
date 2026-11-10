// The machine's Screen Sharing stream as noVNC wants a socket: a WebSocket-
// like channel whose bytes travel as ScreenShareData over the machine's
// end-to-end encrypted link. noVNC speaks VNC (and Apple's authentication)
// with the system's service through it; the machine only relays the bytes.
//
// The channel listens before it asks the machine to open the session: the
// service greets at once, and those first bytes wait here until noVNC
// attaches (sets onmessage).
import type { MachineLink } from "../link/machine-link.ts";

type Listener = ((event: unknown) => void) | null;

export class VncChannel {
	binaryType = "arraybuffer";
	protocol = "";
	/** Open from the start: the machine opened the stream before noVNC attaches. */
	readyState: "open" | "closed" = "open";
	onopen: Listener = null;
	onclose: Listener = null;
	onerror: Listener = null;
	private receive: Listener = null;
	private early: ArrayBuffer[] = [];
	private streamId = "";
	private readonly stop: () => void;
	/** The session is over (the machine closed it, or this side did). */
	onEnd: (byMachine: boolean) => void = () => undefined;

	private constructor(private readonly link: MachineLink) {
		this.stop = link.onFrame((body) => {
			if (body.case === "screenShareData" && (this.streamId === "" || body.value.streamId === this.streamId)) {
				const data = body.value.data;
				const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
				if (this.receive === null) this.early.push(bytes);
				else this.receive({ data: bytes });
			} else if (body.case === "screenShareClosed" && body.value.streamId === this.streamId) {
				this.ended(true);
			}
		});
	}

	/** Opens the session on the machine (the user tapped); rejects as the machine refuses (off, busy). */
	static async open(link: MachineLink): Promise<VncChannel> {
		const channel = new VncChannel(link);
		try {
			const frame = await link.request({ case: "screenShareOpen", value: {} });
			if (frame.body.case !== "screenShareOpened") throw new Error("the machine did not open the screen");
			channel.streamId = frame.body.value.streamId;
			return channel;
		} catch (err) {
			channel.readyState = "closed";
			channel.stop();
			throw err;
		}
	}

	get onmessage(): Listener {
		return this.receive;
	}

	set onmessage(listener: Listener) {
		this.receive = listener;
		if (listener === null || this.early.length === 0) return;
		const early = this.early;
		this.early = [];
		queueMicrotask(() => {
			for (const data of early) this.receive?.({ data });
		});
	}

	/**
	 * Sends at once, not after the machine answered the piece before: a pointer
	 * moves dozens of times a second, and waiting for each answer would put a
	 * click behind every move still in flight. The link sends in call order and
	 * the machine handles frames in arrival order, so the bytes stay in order.
	 */
	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== "open") return;
		// A copy: noVNC reuses its send buffer.
		const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
		this.link.request({ case: "screenShareData", value: { streamId: this.streamId, data: bytes } }).catch(() => this.ended(true));
	}

	close(): void {
		if (this.readyState === "closed") return;
		this.link.request({ case: "screenShareClose", value: { streamId: this.streamId } }).catch(() => undefined);
		this.ended(false);
	}

	private ended(byMachine: boolean): void {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		this.stop();
		this.onclose?.({ code: 1000, reason: "", wasClean: true });
		this.onEnd(byMachine);
	}
}

/** X11 keysyms of the phone keyboard's special keys (noVNC's sendKey takes keysyms). */
const SPECIAL: Readonly<Record<string, number>> = {
	Backspace: 0xff08,
	Tab: 0xff09,
	Enter: 0xff0d,
	Escape: 0xff1b,
	ArrowLeft: 0xff51,
	ArrowUp: 0xff52,
	ArrowRight: 0xff53,
	ArrowDown: 0xff54,
};

export function keysymOfKey(key: string): number | null {
	return SPECIAL[key] ?? null;
}

/** The keysym of a typed character: Latin-1 keysyms are its code point, the rest of Unicode 0x01000000 + it. */
export function keysymOfChar(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? code : 0x01000000 + code;
}
