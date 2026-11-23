// A machine's link and a page for the Observatory tests: requests answered by
// hand, frames played as the machine sends them, the page's visibility
// switched by the test.
import { create } from "@bufbuild/protobuf";
import { FrameSchema, ObservatoryEventSchema, ObservatoryEventsSchema, ObservatorySessionSource, ObservatorySnapshotSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import type { LinkState } from "../../../src/machines/link/machine-link.ts";
import type { ObservatoryLink } from "../../../src/machines/observatory/observatory-client.ts";

type Body = Parameters<ObservatoryLink["request"]>[0];

/** A link whose answers the test sends by hand. */
export class FakeLink {
	status: LinkState["status"] = { kind: "open" };
	readonly sent: Body[] = [];
	readonly timeouts: (number | undefined)[] = [];
	private readonly frames = new Set<(body: Frame["body"]) => void>();
	private readonly listeners = new Set<() => void>();
	private readonly pending: { resolve: (f: Frame) => void; reject: (e: unknown) => void }[] = [];

	readonly link: ObservatoryLink = {
		request: (body, timeoutMs) => {
			this.sent.push(body);
			this.timeouts.push(timeoutMs);
			return new Promise<Frame>((resolve, reject) => this.pending.push({ resolve, reject }));
		},
		onFrame: (listener) => {
			this.frames.add(listener);
			return () => this.frames.delete(listener);
		},
		subscribe: (listener) => {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		},
		snapshot: () => ({ status: this.status }) as LinkState,
	};

	watches(): boolean[] {
		return this.sent.flatMap((b) => (b.case === "observatoryWatch" && b.value !== undefined ? [b.value.on === true] : []));
	}

	reject(err: unknown): void {
		this.pending.shift()?.reject(err);
	}

	/** The machine sends a frame (the link hands it to its listeners), and with `answer` answers the oldest request with it. */
	deliver(body: Frame["body"], answer = false): void {
		for (const listener of this.frames) listener(body);
		if (answer) this.answer(body);
	}

	answer(body: Frame["body"]): void {
		this.pending.shift()?.resolve(create(FrameSchema, { id: "x", body }));
	}

	setStatus(status: LinkState["status"]): void {
		this.status = status;
		for (const listener of this.listeners) listener();
	}
}

/** A page whose visibility the test switches. */
export function fakePage() {
	let hidden = false;
	const listeners = new Set<() => void>();
	return {
		hidden: () => hidden,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next: boolean) {
			hidden = next;
			for (const l of listeners) l();
		},
	};
}

export const wireSnapshot = (seq: bigint, epoch = 1n, sessionId = "s1"): Frame["body"] => ({
	case: "observatorySnapshot",
	value: create(ObservatorySnapshotSchema, {
		sessionId,
		epoch,
		seq,
		session: { info: { sessionId, projectKey: "github.com/acme/app", source: ObservatorySessionSource.CLI, startedAt: 1_000n } },
		events: [create(ObservatoryEventSchema, { at: 10n, id: "prompt:p1", kind: { case: "prompt", value: { promptId: "p1" } } })],
	}),
});

export const wireEvents = (seqs: readonly bigint[], epoch = 1n, sessionId = "s1"): Frame["body"] => ({
	case: "observatoryEvents",
	value: create(ObservatoryEventsSchema, {
		sessionId,
		epoch,
		events: seqs.map((seq) => create(ObservatoryEventSchema, { seq, at: 100n + seq, id: `tool:t${seq}`, kind: { case: "toolCall", value: { toolUseId: `t${seq}`, station: "FILES" } } })),
	}),
});

