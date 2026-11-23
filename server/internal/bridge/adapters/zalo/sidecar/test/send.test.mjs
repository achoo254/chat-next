import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { API } from "zca-js";
import { installEgressGuard, isAllowed } from "../src/egress-guard.mjs";
import { isRequestId, isUserId, sendFailure, sendText } from "../src/send.mjs";

const key = crypto.randomBytes(16);

/** Zalo's answer envelope: `data` encrypted with the session key, as the library expects it. */
function zaloAnswer(inner) {
	const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
	const data = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]).toString("base64");
	return new Response(JSON.stringify({ error_code: 0, data }), { status: 200 });
}

/**
 * A real zca-js 2.3.0 API object, offline: `fetch` is the given function, and every service of
 * the map points at `<service>-svc.<domain>` (the real map comes from Zalo at login).
 */
function offlineApi(fetch, domain = "chat.zalo.me") {
	const ctx = {
		secretKey: key.toString("base64"),
		API_VERSION: 671,
		API_TYPE: 30,
		imei: "imei-test",
		userAgent: "UA",
		uid: "1",
		cookie: { getCookieString: async () => "", getCookieStringSync: () => "", setCookie: async () => {} },
		options: { polyfill: fetch },
		settings: { features: { sharefile: { max_file: 10, max_size_share_file_v3: 1 }, socket: { retries: {} } } },
	};
	const serviceMap = new Proxy({}, { get: (_, name) => (typeof name === "string" ? [`https://${name}-svc.${domain}`] : undefined) });
	return new API(ctx, serviceMap, ["wss://ws1-msg.chat.zalo.me/"]);
}

/** An error shaped like zca-js 2.3.0's ZaloApiError. */
function zcaError(message, code = null) {
	const error = new Error(message);
	error.name = "ZcaApiError";
	error.code = code;
	return error;
}

test("a text goes out as exactly one request to the chat service of the map, a host the guard already allows", async () => {
	const requests = [];
	const api = offlineApi(async (url, options) => {
		requests.push({ url: new URL(url), method: options.method });
		return zaloAnswer({ error_code: 0, data: { msgId: 4242 } });
	});
	const sent = await sendText(api, "123", "xin chào");
	assert.equal(sent.msgId, "4242");
	assert.ok(sent.ts > 0);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].method, "POST");
	assert.equal(requests[0].url.host, "chat-svc.chat.zalo.me");
	assert.equal(requests[0].url.pathname, "/api/message/sms");
	assert.equal(isAllowed({ host: requests[0].url.host }), true);
});

test("a map that points sending outside zalo.me is refused by the guard, not followed", async () => {
	const blocked = [];
	const uninstall = installEgressGuard({ onBlocked: (target) => blocked.push(target.host) });
	try {
		const api = offlineApi((url, options) => fetch(url, options), "example.com");
		const error = await sendText(api, "123", "xin chào").then(
			() => null,
			(e) => e,
		);
		assert.notEqual(error, null);
		assert.deepEqual(sendFailure(error), { code: "network_error" });
		assert.deepEqual(blocked, ["chat-svc.example.com"]);
	} finally {
		uninstall();
	}
});

test("an answer without a message id leaves the outcome open", async () => {
	const api = offlineApi(async () => zaloAnswer({ error_code: 0, data: {} }));
	const error = await sendText(api, "123", "x").then(
		() => null,
		(e) => e,
	);
	assert.deepEqual(sendFailure(error), { code: "unclear" });
});

test("Zalo's own error code is refused and keeps the number, never the message", async () => {
	const api = offlineApi(async () => new Response(JSON.stringify({ error_code: 114, error_message: "secret server text" }), { status: 200 }));
	const error = await sendText(api, "123", "x").then(
		() => null,
		(e) => e,
	);
	const failure = sendFailure(error);
	assert.deepEqual(failure, { code: "refused", zaloCode: 114 });
	assert.ok(!JSON.stringify(failure).includes("secret"));
});

test("HTTP failures are classified by status", () => {
	assert.deepEqual(sendFailure(zcaError("Request failed with status code 429")), { code: "rate_limited" });
	assert.deepEqual(sendFailure(zcaError("Request failed with status code 401")), { code: "session_rejected" });
	assert.deepEqual(sendFailure(zcaError("Request failed with status code 403")), { code: "session_rejected" });
	assert.deepEqual(sendFailure(zcaError("Request failed with status code 502")), { code: "zalo_unavailable" });
});

test("local refusals, network errors and the rest", () => {
	assert.deepEqual(sendFailure(zcaError("Missing message content")), { code: "bad_request" });
	assert.deepEqual(sendFailure(zcaError("Missing threadId")), { code: "bad_request" });
	assert.deepEqual(sendFailure(zcaError("Failed to parse response data")), { code: "unclear" });
	assert.deepEqual(sendFailure(new TypeError("fetch failed", { cause: new Error("x") })), { code: "network_error" });
	assert.deepEqual(sendFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })), { code: "network_error" });
	assert.deepEqual(sendFailure(new Error("other")), { code: "unclear" });
	assert.deepEqual(sendFailure(undefined), { code: "unclear" });
});

test("ids are checked", () => {
	assert.equal(isUserId("123"), true);
	for (const bad of ["", "12a", "1".repeat(21), 123, null]) assert.equal(isUserId(bad), false, String(bad));
	assert.equal(isRequestId("s1"), true);
	for (const bad of ["", "a b", "x".repeat(41), 1]) assert.equal(isRequestId(bad), false, String(bad));
});

test("the messages and calls the classifier relies on are in the bundled zca-js", async () => {
	const { readFile } = await import("node:fs/promises");
	const bundle = await readFile(new URL("../dist/zalo-sidecar.cjs", import.meta.url), "utf8");
	for (const literal of [
		'message: "Request failed with status code " + response.status',
		'throw new ZaloApiError("Missing message content")',
		'throw new ZaloApiError("Missing threadId")',
		'throw new ZaloApiError("Failed to encrypt message")',
		"throw new ZaloApiError(result.error.message, result.error.code)",
		'finalServiceUrl.pathname = finalServiceUrl.pathname + "/" + (isGroupMessage ? params.mentionInfo ? "mention" : "sendmsg" : "sms")',
		"requestOldMessages(threadType, lastMsgId = null)",
	]) {
		assert.ok(bundle.includes(literal), `bundle no longer contains ${literal}`);
	}
});

test("the entry never calls the actions the owner ruled out", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(new URL("../src/entry.mjs", import.meta.url), "utf8");
	const code = src
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");
	for (const call of ["sendSeenEvent", "sendDeliveredEvent", "sendTypingEvent", "addReaction", "findUser", "getMultiUsersByPhones", "ThreadType.Group,"]) {
		assert.ok(!code.includes(call), `entry.mjs calls ${call}`);
	}
});
