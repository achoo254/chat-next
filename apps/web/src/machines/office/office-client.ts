// Joins the machine's link to the office store of one session: OfficeWatch
// {on} while the office tab is open and the page visible (and again after a
// reconnect, or when the store finds a gap: that is how a device asks for a
// fresh snapshot), {off} when it closes or the page is hidden (a watched
// office holds one of the machine's few slots and keeps it reading). Frames
// go to the store only for this session. At most one watch is in flight, so
// a burst of out-of-order frames asks once. Any frame the link hands out
// counts as word from the machine (the link's own pings answer every 10 s
// while the user looks): the store cuts the power 30 s after the last one
// once the link is down. A watch lost to the link (closed, or no answer in
// time) is not a refusal: a reconnect watches again, a silent machine is
// asked again shortly.
import type { Frame } from "@achoo254/chat-proto/remote/remote";
import { OfflineError, type MachineLink } from "../link/machine-link.ts";
import type { OfficeStore } from "./office-store.ts";

/** What the office needs of a link (tests pass a fake one). */
export type OfficeLink = Pick<MachineLink, "request" | "onFrame" | "subscribe" | "snapshot">;

/** Whether the page is shown, and its changes (the document by default; tests pass their own). */
export interface PageVisibility {
	hidden(): boolean;
	subscribe(listener: () => void): () => void;
}

/** How often the store's clock-driven parts (power, hourglass, closing) are checked. */
export const OFFICE_TICK_MS = 1_000;
/** A watch the machine did not answer while the link stayed open is asked again after this long. */
export const WATCH_RETRY_MS = 3_000;

export interface OfficeClientOptions {
	readonly now: () => number;
	/** The machine refused the watch (too many offices, an unknown session); null once a snapshot came after all. */
	readonly onRefusal?: (err: unknown) => void;
	readonly visibility?: PageVisibility;
}

export interface OfficeConnection {
	/** Stop watching (the tab closed). */
	close(): void;
	/** Ask again after a refusal ("Thử lại"). */
	retry(): void;
}

export const documentVisibility: PageVisibility = {
	hidden: () => document.visibilityState === "hidden",
	subscribe: (listener) => {
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
};

export function connectOffice(link: OfficeLink, threadId: string, store: OfficeStore, options: OfficeClientOptions): OfficeConnection {
	const page = options.visibility ?? documentVisibility;
	let stopped = false;
	let watching = false;
	let hidden = page.hidden();
	let lastHeard = options.now();
	let wasOpen = link.snapshot().status.kind === "open";
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const isOpen = (): boolean => link.snapshot().status.kind === "open";

	const watch = (): void => {
		if (stopped || hidden || watching || !isOpen()) return;
		watching = true;
		link.request({ case: "officeWatch", value: { threadId, on: true } }).then(
			() => {
				watching = false;
			},
			(err: unknown) => {
				watching = false;
				if (stopped) return;
				if (err instanceof OfflineError) {
					// Closed meanwhile: the reconnect watches again. Open but silent: ask again shortly.
					if (isOpen() && retryTimer === null) {
						retryTimer = setTimeout(() => {
							retryTimer = null;
							watch();
						}, WATCH_RETRY_MS);
					}
					return;
				}
				options.onRefusal?.(err);
			},
		);
	};

	const unwatch = (): void => {
		watching = false;
		if (isOpen()) link.request({ case: "officeWatch", value: { threadId, on: false } }).catch(() => undefined);
	};

	const onFrame = (body: Frame["body"]): void => {
		lastHeard = options.now();
		if (hidden) return;
		if (body.case === "officeSnapshot" && body.value.threadId === threadId) {
			watching = false;
			store.applySnapshot(body.value);
			options.onRefusal?.(null);
		} else if (body.case === "officeEvents" && body.value.threadId === threadId) {
			if (store.applyEvents(body.value.epoch, body.value.events) === "need-snapshot") watch();
		}
	};

	const onLink = (): void => {
		const open = isOpen();
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

	const onVisibility = (): void => {
		const now = page.hidden();
		if (now === hidden) return;
		hidden = now;
		if (hidden) {
			unwatch();
			return;
		}
		// Nothing was expected while hidden (no watch, no pings): the silence starts now, not when the page was left.
		lastHeard = options.now();
		if (!isOpen()) store.linkStatus(false, lastHeard);
		watch();
	};

	const offFrame = link.onFrame(onFrame);
	const offLink = link.subscribe(onLink);
	const offPage = page.subscribe(onVisibility);
	store.linkStatus(wasOpen, lastHeard);
	watch();
	const ticker = setInterval(() => {
		if (!hidden) store.tick(options.now());
	}, OFFICE_TICK_MS);

	return {
		close() {
			stopped = true;
			clearInterval(ticker);
			if (retryTimer !== null) clearTimeout(retryTimer);
			offFrame();
			offLink();
			offPage();
			if (!hidden) unwatch();
		},
		retry() {
			watching = false;
			watch();
		},
	};
}
