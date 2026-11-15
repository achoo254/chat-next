// Joins the machine's link to the office store of one session: OfficeWatch
// {on} while the office tab is open (and again after a reconnect, or when the
// store finds a gap: that is how a device asks for a fresh snapshot), {off}
// when it closes. Frames go to the store only for this session. At most one
// watch is in flight, so a burst of out-of-order frames asks once. Any frame
// the link hands out counts as word from the machine (the link's own pings
// answer every 10 s while the user looks): the store cuts the power 30 s
// after the last one once the link is down.
import type { Frame } from "@achoo254/chat-proto/remote/remote";
import type { LinkState, MachineLink } from "../link/machine-link.ts";
import type { OfficeStore } from "./office-store.ts";

/** What the office needs of a link (tests pass a fake one). */
export type OfficeLink = Pick<MachineLink, "request" | "onFrame" | "subscribe" | "snapshot">;

/** How often the store's clock-driven parts (power, hourglass, closing) are checked. */
export const OFFICE_TICK_MS = 1_000;

export interface OfficeClientOptions {
	readonly now: () => number;
	/** The machine refused the watch (an unknown session, an agent without the office). */
	readonly onError?: (err: unknown) => void;
}

export function connectOffice(link: OfficeLink, threadId: string, store: OfficeStore, options: OfficeClientOptions): () => void {
	let stopped = false;
	let watching = false;
	let lastHeard = options.now();
	let wasOpen = link.snapshot().status.kind === "open";

	const watch = (): void => {
		if (stopped || watching || link.snapshot().status.kind !== "open") return;
		watching = true;
		link.request({ case: "officeWatch", value: { threadId, on: true } }).then(
			() => {
				watching = false;
			},
			(err: unknown) => {
				watching = false;
				if (!stopped) options.onError?.(err);
			},
		);
	};

	const onFrame = (body: Frame["body"]): void => {
		lastHeard = options.now();
		if (body.case === "officeSnapshot" && body.value.threadId === threadId) {
			watching = false;
			store.applySnapshot(body.value);
		} else if (body.case === "officeEvents" && body.value.threadId === threadId) {
			if (store.applyEvents(body.value.epoch, body.value.events) === "need-snapshot") watch();
		}
	};

	const onLink = (): void => {
		const state: LinkState = link.snapshot();
		const open = state.status.kind === "open";
		if (open === wasOpen) return;
		wasOpen = open;
		if (open) {
			lastHeard = options.now();
			store.linkStatus(true, lastHeard);
			// A new connection: the machine forgot this watch, and events may have been missed.
			watching = false;
			watch();
		} else store.linkStatus(false, lastHeard);
	};

	const offFrame = link.onFrame(onFrame);
	const offLink = link.subscribe(onLink);
	store.linkStatus(wasOpen, lastHeard);
	watch();
	const ticker = setInterval(() => store.tick(options.now()), OFFICE_TICK_MS);

	return () => {
		stopped = true;
		clearInterval(ticker);
		offFrame();
		offLink();
		if (link.snapshot().status.kind === "open") link.request({ case: "officeWatch", value: { threadId, on: false } }).catch(() => undefined);
	};
}
