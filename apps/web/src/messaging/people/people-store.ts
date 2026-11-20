// The caller's people and link suggestions, one store per session (per
// Remote) so the info column and the contacts screen agree. Listed when a
// screen first shows them, again when another session changes them (the
// people_changed update), after a reconnect (updates may have been missed)
// and after each change made here. Suggestions are kept per user asked
// about; 0 holds every pending suggestion.
import { useEffect, useSyncExternalStore } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { EventKeys } from "@achoo254/chat-core";
import type { Remote } from "../data/remote.ts";
import { useServices, type Services } from "../data/services.tsx";
import { createPeopleApi, type LinkSuggestion, type LinkedPerson, type PeopleApi } from "./people-api.ts";

export interface PeopleSnapshot {
	/**
	 * "loading" until the first list arrives; "error" while the last list
	 * failed (what was known stays); "unsupported" when the server has no
	 * people at all.
	 */
	readonly status: "loading" | "ready" | "error" | "unsupported";
	readonly people: readonly LinkedPerson[];
	/** By the user asked about (0: all of them); missing until listed. */
	readonly suggestions: ReadonlyMap<number, readonly LinkSuggestion[]>;
}

/** What tells the store to list again: another session's change, and the connection. */
export interface PeopleSignals {
	onChanged(listener: () => void): () => void;
	onConnection(listener: () => void): () => void;
	connected(): boolean;
}

export class PeopleStore {
	private state: PeopleSnapshot = { status: "loading", people: [], suggestions: new Map() };
	private readonly listeners = new Set<() => void>();
	/** Screens showing the store, and the suggestion lists they asked for (with how many ask). */
	private watchers = 0;
	private readonly suggestionKeys = new Map<number, number>();
	private detach: (() => void) | null = null;
	private loading: Promise<void> | null = null;
	private again = false;

	constructor(
		private readonly api: PeopleApi,
		private readonly signals: PeopleSignals,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): PeopleSnapshot => this.state;

	/**
	 * A screen shows the people, and the suggestions involving `suggestionsOf`
	 * (0: all; null: none). The first screen starts listening for changes
	 * and lists again; the returned function ends the watch.
	 */
	watch(suggestionsOf: number | null): () => void {
		this.watchers++;
		// A list nobody watched was not kept current: list it again.
		const unwatched = suggestionsOf !== null && !this.suggestionKeys.has(suggestionsOf);
		if (suggestionsOf !== null) this.suggestionKeys.set(suggestionsOf, (this.suggestionKeys.get(suggestionsOf) ?? 0) + 1);
		const first = this.detach === null;
		if (first) this.attach();
		if (first || unwatched) void this.refresh();
		return () => {
			this.watchers--;
			if (suggestionsOf !== null) {
				const left = (this.suggestionKeys.get(suggestionsOf) ?? 1) - 1;
				if (left > 0) this.suggestionKeys.set(suggestionsOf, left);
				else this.suggestionKeys.delete(suggestionsOf);
			}
			if (this.watchers === 0) {
				this.detach?.();
				this.detach = null;
			}
		};
	}

	/** Lists again; calls while a list runs coalesce into one more after it. Never rejects. */
	refresh(): Promise<void> {
		if (this.loading !== null) {
			this.again = true;
			return this.loading;
		}
		this.loading = (async () => {
			do {
				this.again = false;
				await this.load();
			} while (this.again);
			this.loading = null;
		})();
		return this.loading;
	}

	/** Joins users into one person (merging the people they are in), then lists again. */
	link(userIds: readonly number[]): Promise<LinkedPerson> {
		return this.change(() => this.api.link(userIds));
	}

	/** Takes a user out of their person, then lists again. */
	unlink(userId: number): Promise<void> {
		return this.change(() => this.api.unlink(userId));
	}

	/** Says two users are not the same person, then lists again. */
	reject(userA: number, userB: number): Promise<void> {
		return this.change(() => this.api.reject(userA, userB));
	}

	private async change<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} finally {
			await this.refresh();
		}
	}

	private async load(): Promise<void> {
		const keys = [...this.suggestionKeys.keys()];
		try {
			const [people, lists] = await Promise.all([this.api.list(), Promise.all(keys.map((key) => this.api.suggestions(key)))]);
			this.set({ status: "ready", people, suggestions: new Map(keys.map((key, i) => [key, lists[i] ?? []])) });
		} catch (err) {
			const status = ConnectError.from(err).code === Code.Unimplemented ? "unsupported" : "error";
			this.set({ ...this.state, status });
		}
	}

	private attach(): void {
		let connected = this.signals.connected();
		const offChanged = this.signals.onChanged(() => void this.refresh());
		const offConnection = this.signals.onConnection(() => {
			const now = this.signals.connected();
			// Back online: updates may have been missed while the socket was down.
			if (now && !connected && this.loading === null) void this.refresh();
			connected = now;
		});
		this.detach = () => {
			offChanged();
			offConnection();
		};
	}

	private set(next: PeopleSnapshot): void {
		this.state = next;
		for (const listener of [...this.listeners]) listener();
	}
}

function signalsOf(services: Services): PeopleSignals {
	const { source, store } = services;
	return {
		onChanged: (listener) => source.events.subscribe(EventKeys.people, listener),
		onConnection: (listener) => store.subscribe("connection", listener),
		connected: () => store.connectionState() === "connected",
	};
}

const stores = new WeakMap<Remote, PeopleStore>();

/** The people of the signed-in user (one store per Remote, so per session). */
export function peopleOf(services: Services): PeopleStore {
	let store = stores.get(services.remote);
	if (store === undefined) {
		store = new PeopleStore(createPeopleApi(services.transport), signalsOf(services));
		stores.set(services.remote, store);
	}
	return store;
}

/** The people, kept current while the calling screen shows; `suggestionsOf` as in PeopleStore.watch. */
export function usePeople(suggestionsOf: number | null): [PeopleStore, PeopleSnapshot] {
	const store = peopleOf(useServices());
	useEffect(() => store.watch(suggestionsOf), [store, suggestionsOf]);
	return [store, useSyncExternalStore(store.subscribe, store.snapshot)];
}

/** The person `userId` is in, if any. */
export function personOf(people: readonly LinkedPerson[], userId: number): LinkedPerson | undefined {
	return people.find((person) => person.members.some((member) => member.userId === userId));
}
