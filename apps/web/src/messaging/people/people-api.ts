// People (ADR 0025): the caller's own grouping of users that are the same
// person on several apps, a Chat account and the contacts of other apps
// synced with the bridge. Everything is scoped to the caller; the server
// refuses (NotFound) a user the caller has no private chat with. The Connect
// client loads on the first call, so the first screen does not wait for it.
import type { Transport } from "@connectrpc/connect";

/** One identity of a person: a user of Chat or of another app, with the caller's private chat with them. */
export interface PersonMember {
	readonly userId: number;
	/** The user's name now (it can change after the link). */
	readonly name: string;
	/** "telegram", …; "" for a Chat account. */
	readonly app: string;
	/** The caller's private chat with this user; 0 when there is none. */
	readonly chatId: number;
}

/** A person: at least two users, oldest link first. The name is fixed when the link is made. */
export interface LinkedPerson {
	readonly id: number;
	readonly name: string;
	readonly members: readonly PersonMember[];
}

/** "name": equal names after folding case, accents and spaces; weak, never verified. */
export type LinkReason = "name" | "other";

/** Two users that may be the same person, computed when asked and never linked automatically. */
export interface LinkSuggestion {
	readonly first: PersonMember;
	readonly second: PersonMember;
	readonly reason: LinkReason;
}

export interface PeopleApi {
	list(): Promise<LinkedPerson[]>;
	/** Two to 20 distinct users; people they are already in merge into one. */
	link(userIds: readonly number[]): Promise<LinkedPerson>;
	/** A person left with one user is removed. */
	unlink(userId: number): Promise<void>;
	/** `userId` 0: every pending suggestion; otherwise those involving that user. */
	suggestions(userId: number): Promise<LinkSuggestion[]>;
	/** The pair is not suggested again. */
	reject(userA: number, userB: number): Promise<void>;
}

/** The people calls on `transport`, the Connect client loaded on the first call. */
export function createPeopleApi(transport: Transport): PeopleApi {
	let client: Promise<PeopleApi> | null = null;
	const load = (): Promise<PeopleApi> => {
		client ??= import("./people-client.ts").then((module) => module.createPeopleClient(transport));
		return client;
	};
	return {
		list: () => load().then((api) => api.list()),
		link: (userIds) => load().then((api) => api.link(userIds)),
		unlink: (userId) => load().then((api) => api.unlink(userId)),
		suggestions: (userId) => load().then((api) => api.suggestions(userId)),
		reject: (userA, userB) => load().then((api) => api.reject(userA, userB)),
	};
}
