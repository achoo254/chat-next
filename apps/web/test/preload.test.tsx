import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSettled, prefetchWhenIdle, preloadable, resource, UNREAD_KEEP_MS, useLoad, type Resource } from "../src/components/preload.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("resource", () => {
	it("shares one request between the route that starts it and the screen that reads it", async () => {
		const owner = {};
		const fetch = vi.fn(() => Promise.resolve(["a"]));
		const started = resource(owner, "list", fetch);
		const read = resource(owner, "list", fetch);
		expect(read).toBe(started);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await read.promise).toEqual({ ok: true, value: ["a"] });
		// Other owners and keys are separate requests.
		expect(resource({}, "list", fetch)).not.toBe(started);
		expect(resource(owner, "other", fetch)).not.toBe(started);
	});

	it("settles failures instead of rejecting", async () => {
		const failure = new Error("offline");
		const result = await resource({}, "x", () => Promise.reject(failure)).promise;
		expect(result).toEqual({ ok: false, error: failure });
	});

	it("loads again once its reader is gone, or when nobody read it in time", () => {
		const owner = {};
		let now = 0;
		const fetch = vi.fn(() => Promise.resolve(1));
		const first = resource(owner, "k", fetch, () => now);
		const release = first.retain();
		now = UNREAD_KEEP_MS * 3;
		// Still read by a mounted screen: kept however old.
		expect(resource(owner, "k", fetch, () => now)).toBe(first);
		release();
		// The screen left: the next visit loads fresh data.
		const second = resource(owner, "k", fetch, () => now);
		expect(second).not.toBe(first);
		// Started for a route that was left before its screen showed: dropped after a while.
		now += UNREAD_KEEP_MS - 1;
		expect(resource(owner, "k", fetch, () => now)).toBe(second);
		now += 1;
		expect(resource(owner, "k", fetch, () => now)).not.toBe(second);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("gives a settled result on the first render and a pending one when it settles, without suspending", async () => {
		const owner = {};
		const ready = resource(owner, "ready", () => Promise.resolve("sẵn sàng"));
		await ready.promise;
		expect(isSettled(ready.promise)).toBe(true);
		const later = deferred<string>();
		const pending = resource(owner, "pending", () => later.promise);
		expect(isSettled(pending.promise)).toBe(false);
		function Show({ source }: { source: Resource<string> }) {
			const [state] = useLoad(source);
			return <p>{state.status === "ready" ? state.value : state.status}</p>;
		}
		render(
			<Suspense fallback={<p>đang chờ</p>}>
				<Show source={ready} />
				<Show source={pending} />
			</Suspense>,
		);
		expect(screen.getByText("sẵn sàng")).toBeTruthy();
		expect(screen.getByText("loading")).toBeTruthy();
		expect(screen.queryByText("đang chờ")).toBeNull();
		await act(async () => {
			later.resolve("đã tải");
			await pending.promise;
		});
		expect(screen.getByText("đã tải")).toBeTruthy();
	});

	it("keeps a resource while its screen is mounted and drops it after", async () => {
		const owner = {};
		const fetch = vi.fn(() => Promise.resolve(1));
		const source = resource(owner, "kept", fetch, () => 0);
		function Show() {
			useLoad(source);
			return null;
		}
		const view = render(<Show />);
		// Long after: still the same request while the screen shows it.
		expect(resource(owner, "kept", fetch, () => UNREAD_KEEP_MS * 5)).toBe(source);
		view.unmount();
		expect(resource(owner, "kept", fetch, () => UNREAD_KEEP_MS * 5)).not.toBe(source);
		expect(fetch).toHaveBeenCalledTimes(2);
		await Promise.resolve();
	});

	it("gives a screen its first result, then reloads and updates it in place", async () => {
		const owner = {};
		let calls = 0;
		const fetch = () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve([1, 2]));
		const source = resource(owner, "numbers", fetch);
		await source.promise;
		let actions: { reload: () => void; update: (change: (value: number[]) => number[]) => void } | null = null;
		function Numbers() {
			const [state, reload, update] = useLoad(source);
			actions = { reload, update };
			return <p>{state.status === "ready" ? state.value.join(",") : state.status}</p>;
		}
		render(
			<Suspense fallback={null}>
				<Numbers />
			</Suspense>,
		);
		expect(screen.getByText("error")).toBeTruthy();
		act(() => actions?.reload());
		expect(screen.getByText("loading")).toBeTruthy();
		expect(await screen.findByText("1,2")).toBeTruthy();
		act(() => actions?.update((value) => [...value, 3]));
		expect(screen.getByText("1,2,3")).toBeTruthy();
	});
});

describe("preloadable", () => {
	it("renders code fetched ahead without suspending", async () => {
		const load = vi.fn(() => Promise.resolve({ default: ({ name }: { name: string }) => <p>Xin chào {name}</p> }));
		const code = preloadable(load);
		await code.preload();
		// The same promise for every caller (useReady reads it in render).
		expect(code.preload()).toBe(code.preload());
		render(
			<Suspense fallback={<p>đang chờ</p>}>
				<code.Component name="An" />
			</Suspense>,
		);
		expect(screen.getByText("Xin chào An")).toBeTruthy();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("loads on first render when nobody fetched it ahead", async () => {
		const code = preloadable(() => Promise.resolve({ default: () => <p>Màn hình</p> }));
		await act(async () => {
			render(
				<Suspense fallback={<p>đang chờ</p>}>
					<code.Component />
				</Suspense>,
			);
		});
		expect(await screen.findByText("Màn hình")).toBeTruthy();
	});

	it("tries a failed fetch again", async () => {
		let attempts = 0;
		const code = preloadable(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("offline");
			return { default: () => null };
		});
		await code.preload();
		await code.preload();
		expect(attempts).toBe(2);
	});
});

describe("prefetchWhenIdle", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("fetches once the browser is idle, and not after being cancelled", () => {
		let idle: (() => void) | null = null;
		vi.stubGlobal("requestIdleCallback", (run: () => void) => {
			idle = run;
			return 1;
		});
		vi.stubGlobal("cancelIdleCallback", () => undefined);
		const preload = vi.fn(() => Promise.resolve());
		prefetchWhenIdle([preload]);
		expect(preload).not.toHaveBeenCalled();
		(idle as (() => void) | null)?.();
		expect(preload).toHaveBeenCalledTimes(1);

		const cancelled = vi.fn(() => Promise.resolve());
		const cancel = prefetchWhenIdle([cancelled]);
		cancel();
		(idle as (() => void) | null)?.();
		expect(cancelled).not.toHaveBeenCalled();
	});

	it("falls back to a timer where there is no idle callback", () => {
		vi.useFakeTimers();
		vi.stubGlobal("requestIdleCallback", undefined);
		const preload = vi.fn(() => Promise.resolve());
		prefetchWhenIdle([preload]);
		vi.advanceTimersByTime(1999);
		expect(preload).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(preload).toHaveBeenCalledTimes(1);
	});
});
