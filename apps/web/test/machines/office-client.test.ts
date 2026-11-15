// The office's link to the machine: watching on and off, one snapshot request
// at a time when a gap shows, watching again after a reconnect, and the power
// cut from the link's state.
import { create } from "@bufbuild/protobuf";
import { FrameSchema, OfficeEventsSchema, PongSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { connectOffice, type OfficeLink } from "../../src/machines/office/office-client.ts";
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

describe("the office's link", () => {
	let now = T0;
	beforeEach(() => {
		vi.useFakeTimers();
		now = T0;
	});
	afterEach(() => vi.useRealTimers());

	it("watches while open and stops watching when closed", () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		const stop = connectOffice(fake.link, "t1", store, { now: () => now });
		expect(fake.watches()).toEqual([true]);
		fake.deliver(snap(3n), true);
		expect(store.state().status).toBe("live");
		// Another session's frames are not this office's.
		fake.deliver({ case: "officeSnapshot", value: { ...snapshot([director(), staff("a", "scout")]), threadId: "other" } });
		expect(store.state().actors).toHaveLength(1);
		stop();
		expect(fake.watches()).toEqual([true, false]);
	});

	it("asks for a snapshot once when events show a gap, however many frames follow", async () => {
		const fake = new FakeLink();
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now });
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
		connectOffice(fake.link, "t1", store, { now: () => now });
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
		connectOffice(fake.link, "t1", store, { now: () => now, onError });
		(fake as unknown as { pending: { reject: (e: unknown) => void }[] }).pending.shift()?.reject(new Error("unsupported"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onError).toHaveBeenCalledOnce();
	});

	it("sends nothing while the link is down, and watches once it opens", () => {
		const fake = new FakeLink();
		fake.status = { kind: "connecting", attempt: 1 };
		const store = createOfficeStore({ now: () => now });
		connectOffice(fake.link, "t1", store, { now: () => now });
		expect(fake.watches()).toEqual([]);
		fake.setStatus({ kind: "open" });
		expect(fake.watches()).toEqual([true]);
	});
});
