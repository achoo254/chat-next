// What the merged screen remembers on this device (ADR 0025): the target
// chats chosen for each person, and that the user no longer wants to be told
// a message goes to several apps. Kept per signed-in user in this browser
// only; storage that is off or full keeps them for this page.

const TARGETS = "chat:person-targets:";
const CONFIRMED = "chat:person-send-confirmed:";

function defaultStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export class PersonSendPrefs {
	private readonly memory = new Map<string, string>();

	constructor(
		private readonly selfId: number,
		private readonly storage: Storage | null = defaultStorage(),
	) {}

	/** The chats last chosen for the person; null when nothing was chosen yet (or what was kept is unreadable). */
	targets(personId: number): number[] | null {
		const raw = this.read(`${TARGETS}${this.selfId}:${personId}`);
		if (raw === null) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return null;
			const ids = parsed.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
			return ids.length === 0 ? null : ids;
		} catch {
			return null;
		}
	}

	setTargets(personId: number, chatIds: readonly number[]): void {
		this.write(`${TARGETS}${this.selfId}:${personId}`, JSON.stringify(chatIds));
	}

	/** The user asked not to be told again that a message goes to several apps. */
	confirmed(): boolean {
		return this.read(`${CONFIRMED}${this.selfId}`) === "1";
	}

	setConfirmed(): void {
		this.write(`${CONFIRMED}${this.selfId}`, "1");
	}

	private read(key: string): string | null {
		try {
			return this.storage?.getItem(key) ?? this.memory.get(key) ?? null;
		} catch {
			return this.memory.get(key) ?? null;
		}
	}

	private write(key: string, value: string): void {
		this.memory.set(key, value);
		try {
			this.storage?.setItem(key, value);
		} catch {
			// Quota or blocked storage: kept for this page only.
		}
	}
}
