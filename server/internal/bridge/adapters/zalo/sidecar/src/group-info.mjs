// The name and photo of a Zalo group: reading them out of a getGroupInfo answer, and looking them
// up once in a while per group. zca-js 2.3.0 `api.getGroupInfo(ids)` makes exactly one request:
// POST <zpwServiceMap.group[0]>/api/group/getmg-v2, and answers `{ gridInfoMap: { <id>: { name,
// desc, avt, fullAvt, ... } } }`. Members are not read here.
import { createCachedLookup, PEER_MISS_TTL_MS, PEER_TTL_MS } from "./peer-profile.mjs";

/** Most groups asked about in one group_info command. */
export const MAX_GROUPS_PER_READ = 50;

const NO_GROUP = Object.freeze({ name: "", about: "", avatar: "" });

/** A group id: decimal digits. */
export function isGroupId(value) {
	return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

/**
 * The name, description and photo URL of the group `id` in a getGroupInfo answer; only an https URL
 * is passed on as the photo.
 */
export function groupProfile(info, id) {
	const group = info?.gridInfoMap?.[id];
	if (group === undefined || group === null) return NO_GROUP;
	const name = typeof group.name === "string" ? group.name : "";
	const about = typeof group.desc === "string" ? group.desc : "";
	const photo = [group.fullAvt, group.avt].find((url) => typeof url === "string" && url.startsWith("https://")) ?? "";
	return Object.freeze({ name, about, avatar: photo });
}

/**
 * The name and photo of each of `ids` (at most MAX_GROUPS_PER_READ), by id; a group Zalo tells
 * nothing about is left out. One getGroupInfo request for all of them.
 */
export async function readGroups(getGroupInfo, ids) {
	const info = await getGroupInfo(ids);
	const out = {};
	for (const id of ids) {
		const group = groupProfile(info, id);
		if (group.name !== "" || group.avatar !== "") out[id] = group;
	}
	return out;
}

/** Makes `lookup(id)`: the name and photo of a group, cached like a person's profile; it never rejects. */
export function createGroupLookup({ getGroupInfo, log = () => {}, now, waitMs }) {
	return createCachedLookup({
		read: async (id) => groupProfile(await getGroupInfo(id), id),
		empty: NO_GROUP,
		isEmpty: (g) => g.name === "" && g.avatar === "",
		ttlMs: PEER_TTL_MS,
		missTtlMs: PEER_MISS_TTL_MS,
		log,
		now,
		waitMs,
	});
}
