import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ThreadType } from "zca-js";
import { createHistory, MAX_HISTORY_MESSAGES, pageFor } from "../src/history.mjs";

/** A listener that records requests for old messages; the test answers them. */
function fakeListener() {
	const listener = new EventEmitter();
	listener.requests = [];
	listener.requestOldMessages = (type, lastId) => listener.requests.push({ type, lastId });
	return listener;
}

/** A message as zca-js 2.3.0 builds it from an old-messages page (UserMessage). */
function userMessage(data) {
	const self = data.uidFrom === "0";
	return { type: ThreadType.User, threadId: self ? data.idTo : data.uidFrom, isSelf: self, data };
}

test("the page is cut down to one person and says how far back it reaches", () => {
	const page = pageFor(
		[
			userMessage({ uidFrom: "0", idTo: "500", msgId: "11", msgType: "webchat", content: "đã gửi", ts: "3000" }),
			userMessage({ uidFrom: "500", idTo: "0", msgId: "10", msgType: "webchat", content: "chào", ts: "2000" }),
			userMessage({ uidFrom: "600", idTo: "0", msgId: "9", msgType: "webchat", content: "người khác", ts: "1000" }),
			userMessage({ uidFrom: "500", idTo: "0", msgId: "12", msgType: "chat.sticker", content: { id: 1 }, ts: "4000" }),
		],
		"500",
	);
	assert.equal(page.count, 4);
	assert.equal(page.oldestTs, 1000);
	assert.deepEqual(
		page.messages.map((m) => [m.msgId, m.self, m.content]),
		[
			["10", false, "chào"],
			["11", true, "đã gửi"],
			["12", false, null],
		],
	);
	assert.ok(!JSON.stringify(page).includes("người khác"));
});

test("only the newest messages of the person are handed back", () => {
	const many = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => userMessage({ uidFrom: "500", idTo: "0", msgId: String(i), ts: String(1000 + i) }));
	const page = pageFor(many, "500");
	assert.equal(page.messages.length, MAX_HISTORY_MESSAGES);
	assert.equal(page.messages[0].msgId, "5");
});

test("a request is answered by the next page of 1-1 chats", async () => {
	const listener = fakeListener();
	const history = createHistory(listener, { isConnected: () => true, timeoutMs: 1000 });
	const reading = history.read("500");
	assert.deepEqual(listener.requests, [{ type: ThreadType.User, lastId: null }]);
	listener.emit("old_messages", [userMessage({ uidFrom: "0", idTo: "777", msgId: "1", ts: "5" })], ThreadType.Group); // not ours
	listener.emit("old_messages", [userMessage({ uidFrom: "0", idTo: "500", msgId: "2", msgType: "webchat", content: "x", ts: "9" })], ThreadType.User);
	const page = await reading;
	assert.equal(page.messages.length, 1);
	assert.equal(page.oldestTs, 9);
});

test("no listener, a request already open, and no page in time are errors", async () => {
	const down = createHistory(fakeListener(), { isConnected: () => false, timeoutMs: 1000 });
	await assert.rejects(down.read("500"), { code: "listener_down" });

	const listener = fakeListener();
	const history = createHistory(listener, { isConnected: () => true, timeoutMs: 50 });
	const first = history.read("500");
	await assert.rejects(history.read("500"), { code: "busy" });
	await assert.rejects(first, { code: "timeout" });
	// A page arriving late is not handed to a later request by mistake.
	const again = history.read("500");
	listener.emit("old_messages", [], ThreadType.User);
	assert.equal((await again).count, 0);
});
