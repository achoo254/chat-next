import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { createPeerLookup, PEER_MISS_TTL_MS, peerProfile } from "../src/peer-profile.mjs";

const AVATAR = "https://s120-ava-talk.zadn.vn/a/b/c/d/1/120/abc.jpg";

test("reads the name and photo of a changed profile", () => {
	const info = { changed_profiles: { 42: { displayName: "Lan", zaloName: "lan", avatar: AVATAR } } };
	assert.deepEqual(peerProfile(info, "42"), { name: "Lan", avatar: AVATAR, phone: "" });
});

test("finds a profile kept under the _0 suffix, in the unchanged group", () => {
	const info = { changed_profiles: {}, unchanged_profiles: { "42_0": { zaloName: "lan", avatar: AVATAR } } };
	assert.deepEqual(peerProfile(info, "42"), { name: "lan", avatar: AVATAR, phone: "" });
});

test("passes on only an https photo URL", () => {
	for (const avatar of ["http://s120-ava-talk.zadn.vn/x.jpg", "javascript:alert(1)", 7, null]) {
		const info = { changed_profiles: { 42: { displayName: "Lan", avatar } } };
		assert.deepEqual(peerProfile(info, "42"), { name: "Lan", avatar: "", phone: "" });
	}
});

test("gives nothing for an answer without the person", () => {
	assert.deepEqual(peerProfile({ changed_profiles: { 7: { displayName: "x" } } }, "42"), { name: "", avatar: "", phone: "", seen: 0 });
	assert.deepEqual(peerProfile(undefined, "42"), { name: "", avatar: "", phone: "", seen: 0 });
});

test("passes on the phone number of a full profile only, and only a plain number", () => {
	const full = { changed_profiles: { 42: { displayName: "Lan", avatar: AVATAR, phoneNumber: "84900000001" } } };
	assert.deepEqual(peerProfile(full, "42"), { name: "Lan", avatar: AVATAR, phone: "84900000001" });
	const unchanged = { unchanged_profiles: { 42: { zaloName: "lan", phoneNumber: "84900000001" } } };
	assert.equal(peerProfile(unchanged, "42").phone, "");
	for (const phoneNumber of ["", "abc", "84900000001;x", 84900000001, null, "1".repeat(40)]) {
		const info = { changed_profiles: { 42: { displayName: "Lan", phoneNumber } } };
		assert.equal(peerProfile(info, "42").phone, "", String(phoneNumber));
	}
});

/** A getUserInfo whose answers the test releases by hand. */
function slowUserInfo() {
	const calls = [];
	const getUserInfo = (uid) =>
		new Promise((resolve, reject) => {
			calls.push({ uid, resolve, reject });
		});
	return { calls, getUserInfo };
}

const answer = (uid) => ({ changed_profiles: { [uid]: { displayName: "Lan", avatar: AVATAR } } });

test("messages of one person share one lookup and keep their order", async () => {
	const { calls, getUserInfo } = slowUserInfo();
	const lookup = createPeerLookup({ getUserInfo, waitMs: 1000 });
	const order = [];
	const first = lookup("42").then((p) => order.push(["1", p.avatar]));
	const second = lookup("42").then((p) => order.push(["2", p.avatar]));
	assert.equal(calls.length, 1);
	calls[0].resolve(answer("42"));
	await Promise.all([first, second]);
	assert.deepEqual(order, [["1", AVATAR], ["2", AVATAR]]);
	assert.deepEqual(await lookup("42"), { name: "Lan", avatar: AVATAR, phone: "", seen: 0 });
	assert.equal(calls.length, 1, "a kept profile is not asked for again");
});

test("a slow lookup lets the message go without the profile, and serves the next one", async () => {
	const { calls, getUserInfo } = slowUserInfo();
	const lookup = createPeerLookup({ getUserInfo, waitMs: 20 });
	assert.deepEqual(await lookup("42"), { name: "", avatar: "", phone: "", seen: 0 });
	calls[0].resolve(answer("42"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await lookup("42"), { name: "Lan", avatar: AVATAR, phone: "", seen: 0 });
	assert.equal(calls.length, 1);
});

test("a failed or empty lookup is kept for a while, then asked again", async () => {
	let clock = 1_000;
	const outcomes = [];
	let calls = 0;
	const lookup = createPeerLookup({
		getUserInfo: async () => {
			calls++;
			throw new Error("down");
		},
		log: (o) => outcomes.push(o),
		now: () => clock,
	});
	assert.deepEqual(await lookup("42"), { name: "", avatar: "", phone: "", seen: 0 });
	await lookup("42");
	assert.equal(calls, 1);
	clock += PEER_MISS_TTL_MS + 1;
	await lookup("42");
	assert.equal(calls, 2);
	assert.deepEqual(outcomes, ["failed", "failed"]);
});

test("the last-online time comes with the profile, and a failed or hidden one is 0", async () => {
	const NOW = 1_800_000_000_000;
	const getUserInfo = async (uid) => answer(uid);
	const seenOf = async (getLastOnline) => (await createPeerLookup({ getUserInfo, getLastOnline, now: () => NOW })("42")).seen;
	assert.equal(await seenOf(async () => ({ settings: { show_online_status: true }, lastOnline: NOW - 5000 })), NOW - 5000);
	assert.equal(await seenOf(async () => ({ settings: { show_online_status: false }, lastOnline: 0 })), 0);
	assert.equal(await seenOf(async () => ({ lastOnline: NOW + 3_600_000 })), 0, "a time in the future is not believed");
	assert.equal(await seenOf(async () => { throw new Error("refused"); }), 0);
	const lookup = createPeerLookup({ getUserInfo, getLastOnline: async () => { throw new Error("x"); }, now: () => NOW });
	assert.equal((await lookup("42")).name, "Lan", "the profile survives a failed last-online call");
});
