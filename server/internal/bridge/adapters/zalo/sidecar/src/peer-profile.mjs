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
 * Makes `lookup(uid)`: the name, photo URL and last-online time (`seen`, ms, 0 when unknown) of a person, each "" when unknown; it never
 * rejects. One getUserInfo per person every PEER_TTL_MS (PEER_MISS_TTL_MS after an empty or
 * failed answer), shared by the messages that arrive while it runs, so they still go out in
 * order. A message waits at most `waitMs`; the lookup goes on and serves the next message.
 * `log` is told only "ok", "empty" or "failed", never the name, photo or id.
 */
export function createPeerLookup({ getUserInfo, getLastOnline = async () => null, log = () => {}, now = Date.now, waitMs = PEER_WAIT_MS }) {
	const kept = new Map(); // uid -> { name, avatar, seen, until }
	const running = new Map(); // uid -> Promise of the profile

	function start(uid) {
		const lookup = (async () => {
			try {
				// The last-online call may fail or be refused without the profile being lost.
				const [info, online] = await Promise.all([getUserInfo(uid), Promise.resolve(getLastOnline(uid)).catch(() => null)]);
				const found = { ...peerProfile(info, uid), seen: lastOnlineMs(online, now()) };
				const empty = found.name === "" && found.avatar === "" && found.seen === 0;
				log(empty ? "empty" : "ok");
				kept.set(uid, { ...found, until: now() + (empty ? PEER_MISS_TTL_MS : PEER_TTL_MS) });
				return found;
			} catch {
				log("failed");
				kept.set(uid, { ...NO_PROFILE, until: now() + PEER_MISS_TTL_MS });
				return NO_PROFILE;
			} finally {
				running.delete(uid);
			}
		})();
		running.set(uid, lookup);
		return lookup;
	}

	return async function lookup(uid) {
		const have = kept.get(uid);
		if (have !== undefined && now() < have.until) return { name: have.name, avatar: have.avatar, seen: have.seen };
		const pending = running.get(uid) ?? start(uid);
		let timer;
		const late = new Promise((resolve) => {
			timer = setTimeout(() => resolve(NO_PROFILE), waitMs);
		});
		try {
			return await Promise.race([pending, late]);
		} finally {
			clearTimeout(timer);
		}
	};
}
