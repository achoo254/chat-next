// Unsent composer text per chat (and topic), kept in this browser only. The
// chat list shows it as "Nháp:" (mockups/chat.html#list-states). Drafts are
// removed with the rest of the local data on sign-out.

const PREFIX = "chat:draft:";

export class Drafts {
	private readonly cache = new Map<string, string>();
	private readonly listeners = new Map<string, Set<() => void>>();

	constructor(
		private readonly userId: number,
		private readonly storage: Storage | null = safeStorage(),
	) {}

	private key(chatId: number, topicId: number): string {
		return `${PREFIX}${this.userId}:${chatId}${topicId === 0 ? "" : `:${topicId}`}`;
	}

	get(chatId: number, topicId = 0): string {
		const key = this.key(chatId, topicId);
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;
		const value = readItem(this.storage, key);
		this.cache.set(key, value);
		return value;
	}

	set(chatId: number, text: string, topicId = 0): void {
		const key = this.key(chatId, topicId);
		const value = text.trim() === "" ? "" : text;
		if (this.get(chatId, topicId) === value) return;
		this.cache.set(key, value);
		try {
			if (value === "") this.storage?.removeItem(key);
			else this.storage?.setItem(key, value);
		} catch {
			// Quota or blocked storage: the draft lives for this page only.
		}
		for (const listener of this.listeners.get(`${chatId}`) ?? []) listener();
	}

	subscribe(chatId: number, listener: () => void): () => void {
		const id = `${chatId}`;
		let set = this.listeners.get(id);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(id, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	/** Removes every draft of this user (sign-out). */
	clear(): void {
		this.cache.clear();
		if (this.storage === null) return;
		try {
			const mine = `${PREFIX}${this.userId}:`;
			const keys: string[] = [];
			for (let i = 0; i < this.storage.length; i++) {
				const key = this.storage.key(i);
				if (key?.startsWith(mine) === true) keys.push(key);
			}
			for (const key of keys) this.storage.removeItem(key);
		} catch {
			// Nothing more to do when storage is blocked.
		}
	}
}

function readItem(storage: Storage | null, key: string): string {
	try {
		return storage?.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function safeStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
