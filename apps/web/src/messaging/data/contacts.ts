// The caller's contact list ("Danh bạ", mockups/chat.html#contacts): the
// people they added themselves. Privacy settings set to "Danh bạ" mean this
// list; sharing a chat never adds anyone. Loaded in full on first use (the
// server pages it by user id, the screens sort it by name) and kept per
// Remote, so the contacts screen, profiles and the info column agree.
import { useEffect, useSyncExternalStore } from "react";
import type { ContactTarget, Person, Remote } from "./remote.ts";

/** At most 10 000 contacts in pages of 500. */
const MAX_PAGES = 20;

export interface ContactsSnapshot {
	readonly status: "idle" | "loading" | "ready" | "error";
	/** Sorted by name. */
	readonly people: readonly Person[];
	readonly ids: ReadonlySet<number>;
}

const collator = new Intl.Collator("vi", { sensitivity: "base" });

function snapshotOf(status: ContactsSnapshot["status"], byId: ReadonlyMap<number, Person>): ContactsSnapshot {
	const people = [...byId.values()].sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
	return { status, people, ids: new Set(byId.keys()) };
}

export class Contacts {
	private byId = new Map<number, Person>();
	private current: ContactsSnapshot = { status: "idle", people: [], ids: new Set() };
	private loading: Promise<void> | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly remote: Remote) {}

	snapshot = (): ContactsSnapshot => this.current;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Loads the whole list once; `force` loads it again (retry after an error). */
	load(force = false): Promise<void> {
		if (this.loading !== null) return this.loading;
		if (!force && this.current.status === "ready") return Promise.resolve();
		this.set("loading");
		this.loading = (async () => {
			try {
				const byId = new Map<number, Person>();
				let cursor = "";
				let pages = 0;
				do {
					const page = await this.remote.contacts(cursor);
					for (const person of page.items) byId.set(person.id, person);
					cursor = page.nextCursor;
					pages++;
				} while (cursor !== "" && pages < MAX_PAGES);
				this.byId = byId;
				this.set("ready");
			} catch {
				this.set("error");
			} finally {
				this.loading = null;
			}
		})();
		return this.loading;
	}

	/** Adds someone to the list; rejects with the server error (NotFound when hidden by privacy). */
	async add(target: ContactTarget): Promise<Person> {
		const person = await this.remote.addContact(target);
		this.byId.set(person.id, person);
		this.set(this.current.status);
		return person;
	}

	async remove(userId: number): Promise<void> {
		await this.remote.deleteContact(userId);
		this.byId.delete(userId);
		this.set(this.current.status);
	}

	private set(status: ContactsSnapshot["status"]): void {
		this.current = snapshotOf(status, this.byId);
		for (const listener of [...this.listeners]) listener();
	}
}

const stores = new WeakMap<Remote, Contacts>();

/** The contact list of the signed-in user (one per Remote, so per session). */
export function contactsOf(remote: Remote): Contacts {
	let contacts = stores.get(remote);
	if (contacts === undefined) {
		contacts = new Contacts(remote);
		stores.set(remote, contacts);
	}
	return contacts;
}

/** The contact list, loaded on first use. */
export function useContacts(remote: Remote): ContactsSnapshot {
	const contacts = contactsOf(remote);
	useEffect(() => {
		void contacts.load();
	}, [contacts]);
	return useSyncExternalStore(contacts.subscribe, contacts.snapshot);
}
