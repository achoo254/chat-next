// The profile (name, photo and phone number) of the other person of a 1-1 chat: reading it
// out of a getUserInfo answer, and looking it up once in a while per person.
import { clearTimeout, setTimeout } from "node:timers";

/** How long a looked-up profile is reused before the next message asks again (a new photo shows after that). */
export const PEER_TTL_MS = 6 * 60 * 60 * 1000;
/** How long an empty or failed lookup is reused, so a person Zalo tells nothing about is not asked for on every message. */
export const PEER_MISS_TTL_MS = 10 * 60 * 1000;
/** How long a message waits for its lookup before it goes out without the name and photo. */
export const PEER_WAIT_MS = 3000;

/** The longest phone number passed on; anything longer is not a number. */
const PHONE_MAX = 32;

const NO_PROFILE = Object.freeze({ name: "", avatar: "", phone: "" });

/**
 * The phone number a full profile (changed_profiles) shows, "" when it shows none. Only a
 * short string of digits, spaces and a leading "+" is passed on; the engine checks the rest.
 */
function profilePhone(profile, full) {
	const raw = full ? profile.phoneNumber : undefined;
	return typeof raw === "string" && raw.length <= PHONE_MAX && /^\+?[0-9 ]*$/.test(raw) ? raw.trim() : "";
}

/**
 * The display name, photo URL and phone number in a getUserInfo answer, which keeps a profile
 * under its id with or without the `_0` suffix. Only an https URL is passed on as the photo;
 * the number only from a full profile (an unchanged one has none). The same lookup the name
 * comes from: no other call is made for the number.
 */
export function peerProfile(info, uid) {
	for (const [group, full] of [
		[info?.changed_profiles, true],
		[info?.unchanged_profiles, false],
	]) {
		const profile = group?.[uid] ?? group?.[`${uid}_0`];
		if (profile === undefined || profile === null) continue;
		const name = String(profile.displayName || profile.zaloName || "");
		const avatar = typeof profile.avatar === "string" && profile.avatar.startsWith("https://") ? profile.avatar : "";
		const phone = profilePhone(profile, full);
		if (name !== "" || avatar !== "" || phone !== "") return { name, avatar, phone };
	}
	return NO_PROFILE;
}

/**
 * Makes `lookup(uid)`: the name, photo URL and phone number of a person, each "" when unknown; it never
 * rejects. One getUserInfo per person every PEER_TTL_MS (PEER_MISS_TTL_MS after an empty or
 * failed answer), shared by the messages that arrive while it runs, so they still go out in
 * order. A message waits at most `waitMs`; the lookup goes on and serves the next message.
 * `log` is told only "ok", "empty" or "failed", never the name, photo, number or id.
 */
export function createPeerLookup({ getUserInfo, log = () => {}, now = Date.now, waitMs = PEER_WAIT_MS }) {
	const kept = new Map(); // uid -> { name, avatar, phone, until }
	const running = new Map(); // uid -> Promise of the profile

	function start(uid) {
		const lookup = (async () => {
			try {
				const found = peerProfile(await getUserInfo(uid), uid);
				const empty = found.name === "" && found.avatar === "" && found.phone === "";
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
		if (have !== undefined && now() < have.until) return { name: have.name, avatar: have.avatar, phone: have.phone };
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
