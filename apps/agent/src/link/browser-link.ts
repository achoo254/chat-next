// The tunelo browser on one device's link: takeovers and passkey notices go
// to the device unasked; its requests (open the browser, view a tab, input,
// give it back) go to the RemoteBrowser. Pictures and input pass through
// here end-to-end encrypted and are never logged. Input of one device is
// applied strictly in order, apart from its other requests.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { BrowserMouseType, type BrowserInput, type Frame, type FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { InputError, type InputAction, type MouseKind } from "../remote-browser/browser-input.ts";
import type { BrowserEvent, BrowserViewer, RemoteBrowser, TakeoverInfo } from "../remote-browser/remote-browser.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;
export type BrowserFrame = Extract<Frame["body"], { case: "browserControl" | "browserView" | "browserInput" | "browserTakeoverEnd" }>;

/** More than this unsent on the device's socket: pictures are skipped until it drains. */
const BUSY_BYTES = 512 * 1024;

const MOUSE: Partial<Record<BrowserMouseType, MouseKind>> = {
	[BrowserMouseType.MOVE]: "move",
	[BrowserMouseType.DOWN]: "down",
	[BrowserMouseType.UP]: "up",
	[BrowserMouseType.WHEEL]: "wheel",
};

/** A device's input as the browser takes it. */
export function inputAction(v: BrowserInput): InputAction {
	const a = v.action;
	switch (a.case) {
		case "mouse": {
			const m = a.value;
			const type = MOUSE[m.type];
			if (!type) throw new InputError("not a mouse action");
			return { kind: "mouse", mouse: { type, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount, deltaX: m.deltaX, deltaY: m.deltaY, modifiers: m.modifiers } };
		}
		case "key":
			return { kind: "key", key: { key: a.value.key, code: a.value.code, text: a.value.text, modifiers: a.value.modifiers } };
		case "text":
			return { kind: "text", text: a.value };
		default:
			throw new InputError("no action");
	}
}

export function takeoverBody(t: TakeoverInfo) {
	return { takeoverId: t.takeoverId, threadId: t.threadId, reason: t.reason, url: t.url, expiresAt: BigInt(t.expiresAt) };
}

export class BrowserLink {
	readonly viewer: BrowserViewer;
	private inputs: Promise<void> = Promise.resolve();

	constructor(
		private readonly browser: RemoteBrowser,
		private readonly send: (id: string, body: Body) => void,
		private readonly fail: (id: string, err: unknown) => void,
		buffered: () => number,
		private readonly device: () => string,
	) {
		this.viewer = {
			frame: (f) => this.send("", { case: "browserFrame", value: f }),
			state: (s) => this.send("", { case: "browserState", value: s }),
			busy: () => buffered() > BUSY_BYTES,
		};
	}

	/** Takeovers open now, then every event; returns the unsubscribe. */
	subscribe(): () => void {
		const stop = this.browser.onEvent((event) => this.event(event));
		for (const t of this.browser.openTakeovers()) this.event({ type: "takeover", takeover: t });
		return stop;
	}

	private event(event: BrowserEvent): void {
		switch (event.type) {
			case "takeover":
				return this.send("", { case: "browserTakeover", value: takeoverBody(event.takeover) });
			case "ended":
				return this.send("", { case: "browserTakeoverEnded", value: { takeoverId: event.takeoverId } });
			case "passkey": {
				const n = event.notice;
				return this.send("", { case: "passkeyNotice", value: { origin: n.origin, create: n.create, threadId: n.threadId, at: BigInt(n.at) } });
			}
			default:
				return;
		}
	}

	/** A request of the device; answered by id (or an error by id). */
	handle(id: string, b: BrowserFrame): void {
		const ack = () => this.send(id, { case: "ack", value: {} });
		switch (b.case) {
			case "browserControl":
				void this.browser.startControl().then(
					(t) => this.send(id, { case: "browserTakeover", value: takeoverBody(t) }),
					(err: unknown) => this.fail(id, err),
				);
				return;
			case "browserView": {
				const v = b.value;
				void this.browser
					.view(this.viewer, { takeoverId: v.takeoverId, targetId: v.targetId, on: v.on, maxWidth: v.maxWidth, maxHeight: v.maxHeight })
					.then(ack, (err: unknown) => this.fail(id, err));
				return;
			}
			case "browserInput": {
				const v = b.value;
				// The chain never rejects: a failed input answers its own id and the next one still runs.
				this.inputs = this.inputs
					.then(() => this.browser.input(v.takeoverId, v.targetId, inputAction(v)))
					.then(ack, (err: unknown) => this.fail(id, err));
				return;
			}
			case "browserTakeoverEnd":
				try {
					this.browser.end(b.value.takeoverId, this.device());
					ack();
				} catch (err) {
					this.fail(id, err);
				}
				return;
		}
	}

	/** The device's link closed: it views nothing any more. */
	close(): void {
		this.browser.detach(this.viewer);
	}
}
