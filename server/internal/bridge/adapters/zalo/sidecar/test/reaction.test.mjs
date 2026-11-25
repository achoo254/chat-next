import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { API } from "zca-js";
import { isAllowed } from "../src/egress-guard.mjs";
import { isMessageId, isReactionCode, sendReaction } from "../src/reaction.mjs";
import { sendFailure } from "../src/send.mjs";

const key = crypto.randomBytes(16);

/** Zalo's answer envelope: `data` encrypted with the session key, as the library expects it. */
function zaloAnswer(inner) {
	const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
	const data = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]).toString("base64");
	return new Response(JSON.stringify({ error_code: 0, data }), { status: 200 });
}

/** A real zca-js 2.3.0 API object, offline; every service of the map is `<service>-svc.chat.zalo.me`. */
function offlineApi(fetch) {
	const ctx = {
		secretKey: key.toString("base64"),
		API_VERSION: 671,
		API_TYPE: 30,
		imei: "imei-test",
		userAgent: "UA",
		uid: "1",
		cookie: { getCookieString: async () => "", getCookieStringSync: () => "", setCookie: async () => {} },
		options: { polyfill: fetch },
		settings: { features: { socket: { retries: {} } } },
	};
	const serviceMap = new Proxy({}, { get: (_, name) => (typeof name === "string" ? [`https://${name}-svc.chat.zalo.me`] : undefined) });
	return new API(ctx, serviceMap, ["wss://ws1-msg.chat.zalo.me/"]);
}

test("a reaction goes out as one request to the reaction service of the map, a host the guard allows", async () => {
	const requests = [];
	const api = offlineApi(async (url, options) => {
		requests.push({ url: new URL(url), method: options.method });
		return zaloAnswer({ error_code: 0, data: { msgIds: "[]" } });
	});
	await sendReaction(api, "123", "4242", "17", ":o");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].method, "POST");
	assert.equal(requests[0].url.host, "reaction-svc.chat.zalo.me");
	assert.equal(requests[0].url.pathname, "/api/message/reaction");
	assert.equal(isAllowed({ host: requests[0].url.host }), true);
});

test("an empty code takes the reaction back with the same request", async () => {
	let count = 0;
	const api = offlineApi(async () => {
		count++;
		return zaloAnswer({ error_code: 0, data: { msgIds: "[]" } });
	});
	await sendReaction(api, "123", "4242", "0", "");
	assert.equal(count, 1);
});

test("Zalo's own error code is refused and keeps the number, never the message", async () => {
	const api = offlineApi(async () => new Response(JSON.stringify({ error_code: 114, error_message: "secret server text" }), { status: 200 }));
	const error = await sendReaction(api, "123", "4242", "17", ":o").then(
		() => null,
		(e) => e,
	);
	assert.notEqual(error, null);
	const failure = sendFailure(error);
	assert.equal(failure.code, "refused");
	assert.ok(!JSON.stringify(failure).includes("secret"));
});

test("only Zalo's reaction codes and decimal ids are accepted", () => {
	for (const code of ["/-heart", ":o", "_()_", ""]) assert.equal(isReactionCode(code), true, code);
	for (const code of ["❤️", "heart", "/-nope", null, 3]) assert.equal(isReactionCode(code), false, String(code));
	for (const id of ["0", "4242", "1234567890123456789"]) assert.equal(isMessageId(id), true, id);
	for (const id of ["", "-1", "1e3", "12a", 5, null]) assert.equal(isMessageId(id), false, String(id));
});
