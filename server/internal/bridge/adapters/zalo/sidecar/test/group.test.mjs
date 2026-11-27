import assert from "node:assert/strict";
import test from "node:test";
import { ThreadType } from "zca-js";
import { isAllowed } from "../src/egress-guard.mjs";
import { createGroupLookup, groupProfile, isGroupId, readGroups } from "../src/group-info.mjs";
import { readGroupPage, textHash } from "../src/history.mjs";
import { sendReaction } from "../src/reaction.mjs";
import { sendText } from "../src/send.mjs";
import { sendUndo } from "../src/undo.mjs";
import { offlineApi, zaloAnswer } from "./offline-api.mjs";

/** An API that records each request and answers it with `answer`. */
function recording(answer) {
	const requests = [];
	const api = offlineApi(async (url, options) => {
		requests.push({ url: new URL(url), method: options?.method ?? "GET" });
		return zaloAnswer(answer);
	});
	return { api, requests };
}

test("a text to a group goes out as one request to the group service, a host the guard allows", async () => {
	const { api, requests } = recording({ error_code: 0, data: { msgId: 77 } });
	const sent = await sendText(api, "9001", "chào cả nhóm", ThreadType.Group);
	assert.equal(sent.msgId, "77");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url.host, "group-svc.chat.zalo.me");
	assert.equal(requests[0].url.pathname, "/api/group/sendmsg");
	assert.equal(isAllowed({ host: requests[0].url.host }), true);
});

test("a recall in a group goes to the group service's undomsg, a reaction to the reaction service's group path", async () => {
	const undo = recording({ error_code: 0, data: { status: 0 } });
	await sendUndo(undo.api, "9001", "55", "66", ThreadType.Group);
	assert.equal(undo.requests.length, 1);
	assert.equal(undo.requests[0].url.host, "group-svc.chat.zalo.me");
	assert.equal(undo.requests[0].url.pathname, "/api/group/undomsg");

	const react = recording({ error_code: 0, data: { msgIds: "[55]" } });
	await sendReaction(react.api, "9001", "55", "66", "/-heart", ThreadType.Group);
	assert.equal(react.requests.length, 1);
	assert.equal(react.requests[0].url.host, "reaction-svc.chat.zalo.me");
	assert.equal(react.requests[0].url.pathname, "/api/group/reaction");
});

test("a person's commands still go to the 1-1 paths when no type is given", async () => {
	const { api, requests } = recording({ error_code: 0, data: { msgId: 1 } });
	await sendText(api, "123", "x");
	assert.equal(requests[0].url.pathname, "/api/message/sms");
});

test("the name and photo of groups come from one getmg-v2 request; only https photos and known groups are kept", async () => {
	const { api, requests } = recording({
		error_code: 0,
		data: {
			gridInfoMap: {
				9001: { name: "Nhà mình", desc: "Gia đình", fullAvt: "https://s120-ava-grp-talk.zadn.vn/a.jpg", avt: "https://x.zadn.vn/b.jpg" },
				9002: { name: "", avt: "http://insecure.zadn.vn/c.jpg" },
			},
		},
	});
	const groups = await readGroups((ids) => api.getGroupInfo(ids), ["9001", "9002", "9003"]);
	assert.deepEqual(groups, { 9001: { name: "Nhà mình", about: "Gia đình", avatar: "https://s120-ava-grp-talk.zadn.vn/a.jpg" } });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url.host, "group-svc.chat.zalo.me");
	assert.equal(requests[0].url.pathname, "/api/group/getmg-v2");
});

test("groupProfile falls back to the small photo and tells nothing for a group not in the answer", () => {
	assert.deepEqual(groupProfile({ gridInfoMap: { 1: { name: "A", avt: "https://x.zadn.vn/s.jpg" } } }, "1"), { name: "A", about: "", avatar: "https://x.zadn.vn/s.jpg" });
	assert.deepEqual(groupProfile({}, "1"), { name: "", about: "", avatar: "" });
	assert.deepEqual(groupProfile(null, "1"), { name: "", about: "", avatar: "" });
	assert.equal(isGroupId("123"), true);
	assert.equal(isGroupId("g123"), false);
});

test("a group is looked up once and then served from the cache", async () => {
	let calls = 0;
	const lookup = createGroupLookup({
		getGroupInfo: async (id) => {
			calls++;
			return { gridInfoMap: { [id]: { name: "Lớp 12A" } } };
		},
		now: () => 1_000,
		waitMs: 1000,
	});
	assert.deepEqual(await lookup("5"), { name: "Lớp 12A", about: "", avatar: "" });
	assert.deepEqual(await lookup("5"), { name: "Lớp 12A", about: "", avatar: "" });
	assert.equal(calls, 1);
});

test("a failed group lookup gives no name and is not asked again at once", async () => {
	let calls = 0;
	const lookup = createGroupLookup({
		getGroupInfo: async () => {
			calls++;
			throw new Error("down");
		},
		now: () => 1_000,
		waitMs: 1000,
	});
	assert.deepEqual(await lookup("5"), { name: "", about: "", avatar: "" });
	await lookup("5");
	assert.equal(calls, 1);
});

test("a group's history page is read from the group service and keeps only hashes", async () => {
	const { api, requests } = recording({
		error_code: 0,
		data: {
			groupMsgs: [
				{ uidFrom: "0", idTo: "9001", msgType: "webchat", content: "mình gửi", msgId: "11", cliMsgId: "21", ts: "2000" },
				{ uidFrom: "42", idTo: "9001", msgType: "webchat", content: "bạn gửi", msgId: "10", cliMsgId: "20", ts: "1000" },
			],
		},
	});
	const page = await readGroupPage((g, n) => api.getGroupChatHistory(g, n), "9001");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url.host, "group-svc.chat.zalo.me");
	assert.equal(requests[0].url.pathname, "/api/group/history");
	assert.equal(page.count, 2);
	assert.equal(page.oldestTs, 1000);
	assert.deepEqual(
		page.messages.map((m) => [m.msgId, m.self, m.textHash]),
		[
			["10", false, textHash("bạn gửi")],
			["11", true, textHash("mình gửi")],
		],
	);
});
