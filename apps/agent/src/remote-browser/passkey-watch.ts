/**
 * Noticing a page of the tunelo browser that asks for a real passkey: a
 * script added to every page wraps `navigator.credentials.create/get` and,
 * for a WebAuthn request that is not passkey autofill (`mediation:
 * "conditional"`), calls a binding before handing the call on unchanged.
 * The page's own call goes on as before (the OS passkey dialog opens on the
 * machine); tunelo only learns that it happened, never what was asked.
 *
 * Notices are held back per site and kind for a while, so a page that loops
 * does not flood the devices or Claude.
 */

export const PASSKEY_BINDING = "__tuneloPasskeyWanted";

export const PASSKEY_SCRIPT = `(() => {
	const c = globalThis.navigator && navigator.credentials;
	if (!c || c.__tuneloWatched) return;
	const tell = globalThis[${JSON.stringify(PASSKEY_BINDING)}];
	if (typeof tell !== "function") return;
	for (const kind of ["create", "get"]) {
		const own = c[kind];
		if (typeof own !== "function") continue;
		c[kind] = function (options) {
			try {
				if (options && options.publicKey && options.mediation !== "conditional") tell(kind);
			} catch (e) {}
			return own.call(this, options);
		};
	}
	Object.defineProperty(c, "__tuneloWatched", { value: true });
})();`;

const QUIET_MS = 30_000;
/** Notices kept for one session until a tool result carries them. */
const MAX_QUEUED = 5;

export interface PasskeyNoticeInfo {
	origin: string;
	create: boolean;
	threadId: string;
	at: number;
}

/** Whether a notice for this site and kind goes out now (not one in the last 30 s). */
export class PasskeyThrottle {
	private readonly last = new Map<string, number>();

	constructor(private readonly now: () => number) {}

	allow(origin: string, create: boolean): boolean {
		const key = `${create ? "c" : "g"} ${origin}`;
		const at = this.now();
		const before = this.last.get(key);
		if (before !== undefined && at - before < QUIET_MS) return false;
		this.last.set(key, at);
		return true;
	}
}

/** What Claude reads, after its next tool call, when a page asked for a passkey. */
export function passkeyNoticeText(n: Pick<PasskeyNoticeInfo, "origin" | "create">): string {
	const what = n.create ? "to create a passkey" : "for a passkey to sign in";
	return `tunelo: the page ${n.origin} in the tunelo browser asked ${what}, and no virtual authenticator is on. The machine's own passkey dialog needs someone at the machine; the user's devices were told. Choose another way to sign in, call request_takeover so the user can act on the page, or (for the user's own app under test) turn on virtual_authenticator.`;
}

/** Notices waiting for each session's next tool result. */
export class NoticeQueues {
	private readonly queues = new Map<string, string[]>();

	push(key: string, text: string): void {
		const queue = this.queues.get(key) ?? [];
		if (queue.includes(text)) return;
		queue.push(text);
		this.queues.set(key, queue.slice(-MAX_QUEUED));
	}

	take(key: string): string[] {
		const queue = this.queues.get(key) ?? [];
		this.queues.delete(key);
		return queue;
	}

	drop(key: string): void {
		this.queues.delete(key);
	}
}
