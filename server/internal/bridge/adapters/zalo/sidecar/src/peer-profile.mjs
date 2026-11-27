// The profile (name and photo) of the other person of a 1-1 chat: reading it
// out of a getUserInfo answer, and looking it up once in a while per person.
import { clearTimeout, setTimeout } from "node:timers";

/** How long a looked-up profile is reused before the next message asks again (a new photo shows after that). */
export const PEER_TTL_MS = 6 * 60 * 60 * 1000;
/** How long an empty or failed lookup is reused, so a person Zalo tells nothing about is not asked for on every message. */
export const PEER_MISS_TTL_MS = 10 * 60 * 1000;
/** How long a message waits for its lookup before it goes out without the name and photo. */
export const PEER_WAIT_MS = 3000;

const NO_PROFILE = Object.freeze({ name: "", avatar: "", seen: 0 });

/**
 * The display name and photo URL in a getUserInfo answer, which keeps a profile
 * under its id with or without the `_0` suffix. Only an https URL is passed on as the photo.
 * The phone number the profile may show is never read.
 */
export function peerProfile(info, uid) {
	for (const group of [info?.changed_profiles, info?.unchanged_profiles]) {
		const profile = group?.[uid] ?? group?.[`${uid}_0`];
		if (profile === undefined || profile === null) continue;
		const name = String(profile.displayName || profile.zaloName || "");
		const avatar = typeof profile.avatar === "string" && profile.avatar.startsWith("https://") ? profile.avatar : "";
		if (name !== "" || avatar !== "") return { name, avatar };
	}
	return NO_PROFILE;
}

/**
 * When a person was last online, in milliseconds since 1970, from a lastOnline answer; 0 when the
 * answer has no usable time (a person who hides it, or a call that failed).
 */
export function lastOnlineMs(answer, now = Date.now()) {
	const at = answer?.lastOnline;
	return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now + 60_000 ? Math.floor(at) : 0;
}

/**
 * Makes `lookup(id)` over `read(id)`, which resolves to a profile object: one read per id every
 * `ttlMs` (`missTtlMs` after an empty or failed answer, `isEmpty` saying which is empty), shared by
 * the messages that arrive while it runs, so they still go out in order. A message waits at most
 * `waitMs` and then gets `empty`; the read goes on and serves the next message. `lookup` never
 * rejects. `log` is told only "ok", "empty" or "failed", never what was read or the id.
 */
export function createCachedLookup({ read, empty, isEmpty, ttlMs, missTtlMs, log = () => {}, now = Date.now, waitMs = PEER_WAIT_MS }) {
	const kept = new Map(); // id -> { value, until }
	const running = new Map(); // id -> Promise of the value

	function start(id) {
		const lookup = (async () => {
			try {
				const found = await read(id);
				const miss = isEmpty(found);
				log(miss ? "empty" : "ok");
				kept.set(id, { value: found, until: now() + (miss ? missTtlMs : ttlMs) });
				return found;
			} catch {
				log("failed");
				kept.set(id, { value: empty, until: now() + missTtlMs });
				return empty;
			} finally {
				running.delete(id);
			}
		})();
		running.set(id, lookup);
		return lookup;
	}

	return async function lookup(id) {
		const have = kept.get(id);
		if (have !== undefined && now() < have.until) return have.value;
		const pending = running.get(id) ?? start(id);
		let timer;
		const late = new Promise((resolve) => {
			timer = setTimeout(() => resolve(empty), waitMs);
		});
		try {
			return await Promise.race([pending, late]);
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * Makes `lookup(uid)`: the name, photo URL and last-online time (`seen`, ms, 0 when unknown) of a
 * person, each "" when unknown; it never rejects. One getUserInfo per person every PEER_TTL_MS
 * (PEER_MISS_TTL_MS after an empty or failed answer); see createCachedLookup.
 */
export function createPeerLookup({ getUserInfo, getLastOnline = async () => null, log = () => {}, now = Date.now, waitMs = PEER_WAIT_MS }) {
	return createCachedLookup({
		// The last-online call may fail or be refused without the profile being lost.
		read: async (uid) => {
			const [info, online] = await Promise.all([getUserInfo(uid), Promise.resolve(getLastOnline(uid)).catch(() => null)]);
			return Object.freeze({ ...peerProfile(info, uid), seen: lastOnlineMs(online, now()) });
		},
		empty: NO_PROFILE,
		isEmpty: (p) => p.name === "" && p.avatar === "" && p.seen === 0,
		ttlMs: PEER_TTL_MS,
		missTtlMs: PEER_MISS_TTL_MS,
		log,
		now,
		waitMs,
	});
}
