// The office's link to the machine: watching on and off, one snapshot request
// at a time when a gap shows, watching again after a reconnect, and the power
// cut from the link's state.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, FrameSchema, OfficeEventsSchema, PongSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineError, RemoteError, type LinkState } from "../../src/machines/link/machine-link.ts";
import { connectOffice, WATCH_RETRY_MS, type OfficeLink } from "../../src/machines/office/office-client.ts";
import { createOfficeStore } from "../../src/machines/office/office-store.ts";
import { director, ev, snapshot, staff, T0 } from "./office-builders.ts";

type Body = Parameters<OfficeLink["request"]>[0];

/** A link whose answers the test sends by hand. */
class FakeLink {
	status: LinkState["status"] = { kind: "open" };
	readonly sent: Body[] = [];
	private readonly frames = new Set<(body: Frame["body"]) => void>();
	private readonly listeners = new Set<() => void>();
	private readonly pending: { resolve: (f: Frame) => void; reject: (e: unknown) => void }[] = [];

	readonly link: OfficeLink = {
		request: (body) => {
			this.sent.push(body);
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
		return this.sent.flatMap((b) => (b.case === "officeWatch" && b.value !== undefined ? [b.value.on === true] : []));
	}

	/** The oldest request fails. */
	reject(err: unknown): void {
		this.pending.shift()?.reject(err);
	}

	/** The machine sends a frame (the link hands unkept ones to its listeners), then answers the oldest request. */
	deliver(body: Frame["body"], answer = false): void {
		for (const listener of this.frames) listener(body);
		if (answer) this.pending.shift()?.resolve(create(FrameSchema, { id: "x", body }));
	}

	setStatus(status: LinkState["status"]): void {
		this.status = status;
		for (const listener of this.listeners) listener();
	}
}

const snap = (seq: bigint, actors = [director()]): Frame["body"] => ({ case: "officeSnapshot", value: snapshot(actors, { seq }) });
const events = (...list: ReturnType<typeof ev>[]): Frame["body"] => ({ case: "officeEvents", value: create(OfficeEventsSchema, { threadId: "t1", epoch: 1n, events: list }) });

/** A page whose visibility the test switches. */
function fakePage() {
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

const flush = async (): Promise<void> => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("the office's link", () => {
	let now = T0;
	let page = fakePage();
	beforeEach(() => {
		vi.useFakeTimers();
		now = T0;
		page = fakePage();
	});
	afterEach(() => vi.useRealTimers());

	it("watches while open and stops watching when closed", () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		const office = connectOffice(fake.link, "t1", store, { now: () => now, visibility: page });
		expect(fake.watches()).toEqual([true]);
		fake.deliver(snap(3n), true);
		expect(store.state().status).toBe("live");
		// Another session's frames are not this office's.
		fake.deliver({ case: "officeSnapshot", value: { ...snapshot([director(), staff("a", "scout")]), threadId: "other" } });
		expect(store.state().actors).toHaveLength(1);
		office.close();
		expect(fake.watches()).toEqual([true, false]);
	});

	it("asks for a snapshot once when events show a gap, however many frames follow", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now, visibility: page });
		fake.deliver(snap(3n), true);
		await Promise.resolve();
		fake.deliver(events(ev(4, { case: "turnStart", value: {} })));
		expect(fake.watches()).toEqual([true]);
		fake.deliver(events(ev(6, { case: "turnStart", value: {} })));
		fake.deliver(events(ev(7, { case: "turnStart", value: {} })));
		fake.deliver(events(ev(8, { case: "turnStart", value: {} })));
		expect(fake.watches()).toEqual([true, true]);
		fake.deliver(snap(8n, [director(), staff("a1", "tester")]), true);
		await Promise.resolve();
		expect(store.state().actors).toHaveLength(2);
		expect(store.state().awaitingSnapshot).toBe(false);
		// The next gap asks again.
		fake.deliver(events(ev(10, { case: "turnStart", value: {} })));
		expect(fake.watches()).toEqual([true, true, true]);
	});

	it("watches again after the link reconnects, and cuts the power after 30 s without word", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now, visibility: page });
		fake.deliver(snap(1n), true);
		await Promise.resolve();
		// A pong at T0 + 5 s, then the link drops.
		now = T0 + 5_000;
		fake.deliver({ case: "pong", value: create(PongSchema) });
		fake.setStatus({ kind: "offline", attempt: 1 });
		now = T0 + 34_000;
		vi.advanceTimersByTime(1_000);
		expect(store.state().power).toBe("on");
		now = T0 + 35_000;
		vi.advanceTimersByTime(1_000);
		expect(store.state().power).toBe("out");
		fake.setStatus({ kind: "open" });
		expect(fake.watches()).toEqual([true, true]);
		expect(store.state().power).toBe("out");
		fake.deliver(snap(9n), true);
		expect(store.state().power).toBe("on");
	});

	it("says when the machine refuses to watch", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		const onError = vi.fn();
		connectOffice(fake.link, "t1", store, { now: () => now, onRefusal: onError, visibility: page });
		fake.reject(new RemoteError(ErrorCode.INVALID, "limit", ErrorReason.OFFICE_WATCH_LIMIT));
		await flush();
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(RemoteError);
		fake.deliver(snap(2n));
		expect(onError).toHaveBeenLastCalledWith(null);
	});

	it("is no refusal when the link drops mid-watch: the reconnect watches again", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		const onRefusal = vi.fn();
		connectOffice(fake.link, "t1", store, { now: () => now, onRefusal, visibility: page });
		fake.status = { kind: "offline", attempt: 1 };
		fake.reject(new OfflineError());
		fake.setStatus({ kind: "offline", attempt: 1 });
		await flush();
		fake.setStatus({ kind: "open" });
		expect(fake.watches()).toEqual([true, true]);
		fake.deliver(snap(1n), true);
		await flush();
		expect(onRefusal.mock.calls.filter(([err]) => err !== null)).toEqual([]);
		expect(store.state().status).toBe("live");
	});

	it("asks again when the machine does not answer in time while the link stays open", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		const onRefusal = vi.fn();
		connectOffice(fake.link, "t1", store, { now: () => now, onRefusal, visibility: page });
		fake.reject(new OfflineError());
		await flush();
		vi.advanceTimersByTime(WATCH_RETRY_MS);
		expect(fake.watches()).toEqual([true, true]);
		expect(onRefusal).not.toHaveBeenCalled();
	});

	it("stops watching while the page is hidden, and watches again without a power cut when it shows", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now, visibility: page });
		fake.deliver(snap(1n), true);
		await flush();
		page.set(true);
		expect(fake.watches()).toEqual([true, false]);
		// Hidden a long while; the link closes as the page comes back.
		now = T0 + 600_000;
		fake.setStatus({ kind: "connecting", attempt: 1 });
		page.set(false);
		vi.advanceTimersByTime(1_000);
		expect(store.state().power).toBe("on");
		fake.setStatus({ kind: "open" });
		expect(fake.watches()).toEqual([true, false, true]);
	});

	it("sends nothing while the link is down, and watches once it opens", () => {
		const fake = new FakeLink();
		fake.status = { kind: "connecting", attempt: 1 };
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now, visibility: page });
		expect(fake.watches()).toEqual([]);
		fake.setStatus({ kind: "open" });
		expect(fake.watches()).toEqual([true]);
	});
});
