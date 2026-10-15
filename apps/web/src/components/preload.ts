// Starting a screen's code and data together, before it renders, so the
// screen shows once with one loader (delayed-loader.tsx) instead of a loader
// for its code and then another for its data.
//
//   preloadable(load)     a lazy component whose code can be fetched ahead;
//                         once fetched it renders without suspending
//   resource(owner, ...)  a data request shared by the route that starts it
//                         and the screen that reads it (useLoad)
//   prefetchWhenIdle      fetches code of secondary screens once the browser
//                         is idle after startup
//   warm(...loaders)      starts code a screen's data will wait for (a
//                         client loaded on first call), next to the screen's
//                         own code, so neither waits for the other
import { lazy, useEffect, useEffectEvent, useState, type LazyExoticComponent, type ReactNode } from "react";

/** A promise carrying its outcome, read synchronously by isSettled() and the first render of useLoad(). */
type Tracked<T> = Promise<T> & { status?: "fulfilled" | "rejected"; value?: T; reason?: unknown };

function track<T>(promise: Promise<T>): Promise<T> {
	const tracked: Tracked<T> = promise;
	// No "pending" mark: React instruments an unmarked thenable itself, and only
	// then retries the render when it settles.
	promise.then(
		(value) => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		(reason: unknown) => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return promise;
}

// ---------------------------------------------------------------- code

/** A function component (every lazy screen here is one). */
type Screen<P> = (props: P) => ReactNode;

export interface Preloadable<P extends object> {
	readonly Component: LazyExoticComponent<Screen<P>>;
	/** Fetches the code; settles (never rejects) once it is in or has failed. */
	preload(): Promise<void>;
}

/**
 * A thenable that hands over its value synchronously: React.lazy then renders
 * code already fetched without suspending (a suspension would hold the screen
 * back by React's 300 ms reveal throttle).
 */
function settled<T>(value: T): Promise<T> {
	const thenable = {
		then(onFulfilled?: ((value: T) => unknown) | null) {
			onFulfilled?.(value);
			return thenable;
		},
	};
	// React.lazy only calls then() on what its loader returns; the type asks for a Promise.
	return thenable as unknown as Promise<T>;
}

export function preloadable<P extends object>(load: () => Promise<{ default: Screen<P> }>): Preloadable<P> {
	let module: { default: Screen<P> } | null = null;
	let fetching: Promise<{ default: Screen<P> }> | null = null;
	let ready: Promise<void> | null = null;
	const fetch = () => {
		fetching ??= load().then(
			(loaded) => {
				module = loaded;
				return loaded;
			},
			(err: unknown) => {
				// A failed fetch is tried again next time; the render shows the error.
				fetching = null;
				ready = null;
				throw err;
			},
		);
		return fetching;
	};
	return {
		Component: lazy(() => (module === null ? fetch() : settled(module))),
		preload: () =>
			(ready ??= track(
				fetch().then(
					() => undefined,
					() => undefined,
				),
			)),
	};
}

/**
 * Starts loaders now and ignores their outcome: a failed fetch is retried by
 * the call that needs the code, which reports the error there.
 */
export function warm(...loaders: readonly (() => Promise<unknown>)[]): void {
	for (const load of loaders) load().catch(() => undefined);
}

/**
 * Fetches, once the browser is idle and without competing with startup, the
 * code of screens opened later: every module a screen and its first data
 * import on demand, so opening it later requests no code.
 */
export function prefetchWhenIdle(preloads: readonly (() => Promise<unknown>)[]): () => void {
	let cancelled = false;
	const run = () => {
		if (cancelled) return;
		warm(...preloads);
	};
	if (typeof window.requestIdleCallback === "function") {
		const handle = window.requestIdleCallback(run, { timeout: 5000 });
		return () => {
			cancelled = true;
			window.cancelIdleCallback(handle);
		};
	}
	const timer = setTimeout(run, 2000);
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
}

// ---------------------------------------------------------------- data

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface Resource<T> {
	/** The first result (never rejects), tracked so a render can read it at once. */
	readonly promise: Promise<Settled<T>>;
	/** Loads again, outside the cache (retry, refresh). */
	readonly fetch: () => Promise<T>;
	/** Keeps the result for the reader while it is mounted; it is dropped after. */
	retain(): () => void;
}

interface Entry {
	readonly resource: Resource<unknown>;
	readonly startedAt: number;
	users: number;
}

/** How long a result nobody has read yet stays usable (a route preloaded, then left before the screen showed). */
export const UNREAD_KEEP_MS = 10_000;

const caches = new WeakMap<object, Map<string, Entry>>();

/**
 * The request `key` of `owner` (the API object it goes through): started now,
 * or the one already started for the screen being opened. A result is read
 * by one screen visit: after its reader unmounts, the next visit loads again.
 */
export function resource<T>(owner: object, key: string, fetch: () => Promise<T>, now: () => number = () => performance.now()): Resource<T> {
	let entries = caches.get(owner);
	if (entries === undefined) {
		entries = new Map();
		caches.set(owner, entries);
	}
	const existing = entries.get(key);
	if (existing !== undefined && (existing.users > 0 || now() - existing.startedAt < UNREAD_KEEP_MS)) {
		// The cache holds Resource<unknown> under the same key and fetch, so it is this T.
		return existing.resource as Resource<T>;
	}
	const map = entries;
	const entry: Entry = {
		startedAt: now(),
		users: 0,
		resource: {
			promise: track(
				fetch().then(
					(value): Settled<T> => ({ ok: true, value }),
					(error: unknown): Settled<T> => ({ ok: false, error }),
				),
			),
			fetch,
			retain: () => {
				entry.users += 1;
				let released = false;
				return () => {
					if (released) return;
					released = true;
					entry.users -= 1;
					if (entry.users === 0 && map.get(key) === entry) map.delete(key);
				};
			},
		},
	};
	map.set(key, entry);
	return entry.resource as Resource<T>;
}

/** Whether a promise from this module (code preload, resource) has settled, read synchronously. */
export function isSettled(promise: Promise<unknown>): boolean {
	const status = (promise as Tracked<unknown>).status;
	return status === "fulfilled" || status === "rejected";
}

export type Load<T> =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: unknown }
	| { readonly status: "ready"; readonly value: T };

function loadOf<T>(result: Settled<T>): Load<T> {
	return result.ok ? { status: "ready", value: result.value } : { status: "error", error: result.error };
}

/** The resource's result now, or "loading". */
function current<T>(source: Resource<T>): Load<T> {
	const tracked = source.promise as Tracked<Settled<T>>;
	return tracked.status === "fulfilled" && tracked.value !== undefined ? loadOf(tracked.value) : { status: "loading" };
}

/**
 * A screen's data, kept while the screen is mounted. The first result is the
 * resource's (usually started by the route along with the screen's code, so
 * it is often in already); later loads (retry) go to the server again. It
 * never suspends: a screen shows its loader in place (useLoader), so a fast
 * answer is drawn at once rather than after React's Suspense reveal delay.
 * Returns the state, a reload and an update of the loaded value.
 */
export function useLoad<T>(source: Resource<T>): [Load<T>, () => void, (change: (value: T) => T) => void] {
	const [state, setState] = useState<Load<T>>(() => current(source));
	const [attempt, setAttempt] = useState(0);
	useEffect(() => source.retain(), [source]);
	const fetchAgain = useEffectEvent(() => source.fetch());
	useEffect(() => {
		let active = true;
		if (attempt === 0) {
			source.promise.then((result) => {
				if (active) setState((now) => (now.status === "loading" ? loadOf(result) : now));
			});
		} else {
			fetchAgain().then(
				(value) => {
					if (active) setState({ status: "ready", value });
				},
				(error: unknown) => {
					if (active) setState({ status: "error", error });
				},
			);
		}
		return () => {
			active = false;
		};
	}, [source, attempt]);
	const reload = () => {
		setState({ status: "loading" });
		setAttempt((n) => n + 1);
	};
	const update = (change: (value: T) => T) => setState((now) => (now.status === "ready" ? { status: "ready", value: change(now.value) } : now));
	return [state, reload, update];
}
