// A Zalo-like QR login for the fake BridgeService (fake-bridge.ts): the
// first call answers at once, each later call (a poll) waits until the test
// pushes the next reply or the client aborts it, like the server's long poll.
// No real app is ever called. Never imported by production code.
import { Code, ConnectError } from "@connectrpc/connect";
import { BridgeLoginStepKind, type BridgeAccount, type BridgeLoginStep } from "@achoo254/chat-proto/bridge";

/** A 1×1 PNG as the server sends a QR code: a base64 data: URL. */
export const FAKE_QR_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==";

/** What one call of the login answers. An empty `image` is "not ready yet, poll again". */
export type QrReply =
	| { readonly kind: "qr"; readonly image: string }
	| { readonly kind: "confirm" }
	| { readonly kind: "done" }
	| { readonly kind: "error"; readonly code: Code; readonly message: string };

export const QR_LOGIN_ID = "qr-login-1";

export class FakeQrLogin {
	/** What the first call answers. */
	start: QrReply = { kind: "qr", image: "" };
	/** Calls made: starts, polls, and polls the client aborted while they waited. */
	starts = 0;
	polls = 0;
	aborted = 0;
	/** Polls waiting now, and the most that ever waited at once. */
	inFlight = 0;
	maxInFlight = 0;
	private readonly queue: QrReply[] = [];
	private wake: (() => void) | null = null;

	constructor(private readonly connect: () => BridgeAccount) {}

	/** Queues what the next polls answer, in order, and wakes a poll that waits. */
	push(...replies: QrReply[]): void {
		this.queue.push(...replies);
		this.wake?.();
	}

	begin(): BridgeLoginStep {
		this.starts++;
		return this.answer(this.start);
	}

	async poll(signal: AbortSignal): Promise<BridgeLoginStep> {
		this.polls++;
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			const reply = await this.next(signal);
			return this.answer(reply);
		} finally {
			this.inFlight--;
		}
	}

	private next(signal: AbortSignal): Promise<QrReply> {
		return new Promise((resolve, reject) => {
			const take = (): boolean => {
				const reply = this.queue.shift();
				if (reply === undefined) return false;
				this.wake = null;
				resolve(reply);
				return true;
			};
			if (take()) return;
			const onAbort = () => {
				this.aborted++;
				this.wake = null;
				reject(new ConnectError("canceled", Code.Canceled));
			};
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.wake = () => {
				if (take()) signal.removeEventListener("abort", onAbort);
			};
		});
	}

	private answer(reply: QrReply): BridgeLoginStep {
		const step = (kind: BridgeLoginStepKind, prompt: string): BridgeLoginStep => ({ $typeName: "app.v1.BridgeLoginStep", kind, loginId: QR_LOGIN_ID, prompt, fields: [] });
		switch (reply.kind) {
			case "qr":
				return step(BridgeLoginStepKind.QR, reply.image);
			case "confirm":
				return step(BridgeLoginStepKind.CONFIRM, "Confirm the login in Zalo on your phone.");
			case "done":
				return { ...step(BridgeLoginStepKind.DONE, ""), loginId: "", account: this.connect() };
			case "error":
				throw new ConnectError(reply.message, reply.code);
		}
	}
}
