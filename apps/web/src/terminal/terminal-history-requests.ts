// Pages of a session's history asked of the machine (HistoryRequest, docs/terminal-wire.md section 4) for the
// terminal link. The machine serves one page at a time per connection, so the link keeps one request in flight
// and queues the rest. Each request has its own id: an answer to an id no longer waited for (it expired, or the
// screen started over) is dropped. A change of path attaches every session again, and the request in flight goes
// again with the same id, and the machine sends the page again from its first part: parts already collected are
// kept (a page of one id is the same bytes), parts seen twice are skipped, so the two paths may overlap. The machine
// is busy while it still builds or sends a page given up on here: a BUSY answer is asked again a few times, later
// each time. A request not answered within HISTORY_TIMEOUT_MS of going out fails.
import type { Timers } from "../machines/link/machine-link.ts";
import { HistoryErrorCode, encodeHistoryRequest } from "./terminal-wire.ts";

/** A page not answered within this long of going out fails ("could not load the history"). */
export const HISTORY_TIMEOUT_MS = 10_000;
/** A BUSY machine is asked again after these waits, then the page fails. */
export const BUSY_RETRY_MS = [500, 1_000, 2_000] as const;

export type HistoryFailure = "unavailable" | "busy" | "cancelled" | "timeout";

export type HistoryReply =
	/** `rowCount` rows from `firstRow`, oldest first, each ending in CR LF; an `epoch` other than asked: the program cleared the history since. */
	| {
			readonly kind: "rows";
			readonly epoch: number;
			readonly firstRow: number;
			readonly rowCount: number;
			readonly atStart: boolean;
			readonly vt: Uint8Array;
	  }
	| { readonly kind: "failed"; readonly reason: HistoryFailure }
	/** The answer no longer applies (the session's screen started over, or it left this page): nothing to show. */
	| { readonly kind: "dropped" };

/** A History frame as decoded (terminal-wire.ts). */
export interface HistoryPart {
	readonly session: number;
	readonly reqId: number;
	readonly epoch: number;
	readonly firstRow: number;
	readonly rowCount: number;
	readonly part: number;
	readonly parts: number;
	readonly atStart: boolean;
	readonly vt: Uint8Array;
}

interface Pending {
	readonly reqId: number;
	readonly session: number;
	readonly frame: Uint8Array<ArrayBuffer>;
	readonly resolve: (reply: HistoryReply) => void;
	/** The deadline (from when it went out), and a wait before asking a busy machine again. */
	timer: unknown;
	retryTimer: unknown;
	retries: number;
	/** The parts received so far, in order, and the life they belong to. */
	parts: Uint8Array[];
	partsEpoch: number;
}

export interface HistoryRequestsDeps {
	readonly timers: Timers;
	/** Sends a frame on the path in use; false when no path is up (the request goes once the session is attached again). */
	send(frame: Uint8Array<ArrayBuffer>): boolean;
}

export class HistoryRequests {
	private inFlight: Pending | null = null;
	private readonly queue: Pending[] = [];
	private lastId = 0;

	constructor(private readonly deps: HistoryRequestsDeps) {}

	/** Up to `maxRows` rows of `epoch` before `beforeRow`. Never rejects. */
	request(session: number, epoch: number, beforeRow: number, maxRows: number): Promise<HistoryReply> {
		let frame: Uint8Array<ArrayBuffer>;
		const reqId = this.nextId();
		try {
			frame = encodeHistoryRequest(session, reqId, epoch, beforeRow, maxRows);
		} catch {
			return Promise.resolve({ kind: "failed", reason: "unavailable" });
		}
		return new Promise((resolve) => {
			const pending: Pending = {
				reqId,
				session,
				frame,
				resolve,
				parts: [],
				partsEpoch: epoch,
				timer: null,
				retryTimer: null,
				retries: 0,
			};
			this.queue.push(pending);
			this.next();
		});
	}

	/** `session` was attached again (a new path): its request in flight goes again (the machine answers it once). */
	resend(session: number): void {
		const p = this.inFlight;
		if (p === null || p.session !== session) return;
		this.deps.send(p.frame);
	}

	/** One part of a page. */
	part(frame: HistoryPart): void {
		const p = this.inFlight;
		if (p === null || p.reqId !== frame.reqId || p.session !== frame.session) return;
		// A frame of another life replaces the rest of a page cut short by a clear (an empty page of the new life).
		if (frame.epoch !== p.partsEpoch) {
			p.parts = [];
			p.partsEpoch = frame.epoch;
		}
		// Sent again after an Attach: parts already here are skipped; one past a missing part waits for it to come again.
		if (frame.part !== p.parts.length) return;
		p.parts.push(frame.vt.slice());
		if (p.parts.length < frame.parts) return;
		this.finish(p, { kind: "rows", epoch: frame.epoch, firstRow: frame.firstRow, rowCount: frame.rowCount, atStart: frame.atStart, vt: joined(p.parts) });
	}

	/** A HistoryError frame. */
	error(session: number, reqId: number, code: number): void {
		const p = this.inFlight;
		if (p === null || p.reqId !== reqId || p.session !== session) return;
		if (code === HistoryErrorCode.busy && p.retries < BUSY_RETRY_MS.length) {
			const wait = BUSY_RETRY_MS[p.retries] ?? 2_000;
			p.retries += 1;
			this.deps.timers.clearTimeout(p.retryTimer);
			p.retryTimer = this.deps.timers.setTimeout(() => {
				p.retryTimer = null;
				if (this.inFlight === p) this.deps.send(p.frame);
			}, wait);
			return;
		}
		const reason: HistoryFailure = code === HistoryErrorCode.busy ? "busy" : code === HistoryErrorCode.cancelled ? "cancelled" : "unavailable";
		this.finish(p, { kind: "failed", reason });
	}

	/** `session`'s screen started over or it left this page: what it asked for no longer applies. */
	drop(session: number): void {
		this.dropWhere((p) => p.session === session);
	}

	dropAll(): void {
		this.dropWhere(() => true);
	}

	/** The queued ones first, so none of them is sent on the way. */
	private dropWhere(match: (p: Pending) => boolean): void {
		for (const p of this.queue.filter(match)) this.finish(p, { kind: "dropped" });
		if (this.inFlight !== null && match(this.inFlight)) this.finish(this.inFlight, { kind: "dropped" });
	}

	private finish(p: Pending, reply: HistoryReply): void {
		this.deps.timers.clearTimeout(p.timer);
		this.deps.timers.clearTimeout(p.retryTimer);
		if (this.inFlight === p) {
			this.inFlight = null;
			p.resolve(reply);
			this.next();
			return;
		}
		const at = this.queue.indexOf(p);
		if (at < 0) return;
		this.queue.splice(at, 1);
		p.resolve(reply);
	}

	private next(): void {
		if (this.inFlight !== null) return;
		const p = this.queue.shift();
		if (p === undefined) return;
		this.inFlight = p;
		p.timer = this.deps.timers.setTimeout(() => this.finish(p, { kind: "failed", reason: "timeout" }), HISTORY_TIMEOUT_MS);
		// No path now: the request goes when the session is attached again (resend).
		this.deps.send(p.frame);
	}

	/** 1 to 65535, then around again. */
	private nextId(): number {
		this.lastId = (this.lastId % 0xffff) + 1;
		return this.lastId;
	}
}

/** Parts of a frame split over several, in order, as one. */
export function joined(parts: readonly Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0] ?? new Uint8Array();
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
