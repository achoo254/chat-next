import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { API } from "zca-js";
import { isAllowed } from "../src/egress-guard.mjs";
import FormData from "../src/form-data.mjs";
import { createUploads, fileOf, guardUploads, MAX_FILE_BYTES, sendMedia, sendMediaFailure } from "../src/send-media.mjs";

const key = crypto.randomBytes(16);

/** Zalo's answer envelope: `data` encrypted with the session key, as the library expects it. */
function zaloAnswer(data) {
	const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
	const sealed = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data }), "utf8"), cipher.final()]).toString("base64");
	return new Response(JSON.stringify({ error_code: 0, data: sealed }), { status: 200 });
}

/**
 * A real zca-js 2.3.0 API object, offline, with its context (the test plays the listener's
 * file_done through ctx.uploadCallbacks). Every service of the map is `<service>-svc.chat.zalo.me`.
 */
function offlineApi(fetch, { maxSizeMb = 25, chunkSize = 64 * 1024 } = {}) {
	const ctx = {
		secretKey: key.toString("base64"),
		API_VERSION: 671,
		API_TYPE: 30,
		imei: "imei-test",
		userAgent: "UA",
		uid: "1",
		cookie: { getCookieString: async () => "", getCookieStringSync: () => "", setCookie: async () => {} },
		options: { polyfill: fetch },
		uploadCallbacks: new Map(),
		settings: {
			features: {
				sharefile: { max_file: 10, max_size_share_file_v3: maxSizeMb, chunk_size_file: chunkSize, restricted_ext_file: ["exe"] },
				socket: { retries: {} },
			},
		},
	};
	const serviceMap = new Proxy({}, { get: (_, name) => (typeof name === "string" ? [`https://${name}-svc.chat.zalo.me`] : undefined) });
	const api = new API(ctx, serviceMap, ["wss://ws1-msg.chat.zalo.me/"]);
	guardUploads(api, 200);
	return { api, ctx };
}

/** Records each request (url, its multipart body) and answers with answer(path). */
function recorder(answer) {
	const requests = [];
	const fetch = async (url, options) => {
		const u = new URL(url);
		requests.push({ url: u, body: options.body, headers: options.headers });
		return answer(u.pathname);
	};
	return { requests, fetch };
}

const photo = (data, text = "") => ({ kind: "photo", name: "anh.jpg", size: data.length, width: 640, height: 480, text });
const doc = (data) => ({ kind: "file", name: "báo cáo.pdf", size: data.length, width: 0, height: 0, text: "" });

async function failureOf(promise) {
	return promise.then(
		() => null,
		(e) => sendMediaFailure(e),
	);
}

test("a photo is uploaded and posted to the file service of the map, a host the guard already allows, in one message", async () => {
	const data = crypto.randomBytes(150 * 1024); // three upload chunks
	const { requests, fetch } = recorder((path) =>
		path.endsWith("/upload") ? zaloAnswer({ photoId: 77, normalUrl: "https://p", hdUrl: "https://p", thumbUrl: "https://t", finished: 1 }) : zaloAnswer({ msgId: 900 }),
	);
	const { api } = offlineApi(fetch);
	const sent = await sendMedia(api, "123", photo(data, "chú thích"), data);
	assert.equal(sent.msgId, "900");
	const paths = requests.map((r) => r.url.pathname);
	assert.deepEqual(paths, ["/api/message/photo_original/upload", "/api/message/photo_original/upload", "/api/message/photo_original/upload", "/api/message/photo_original/send"]);
	for (const r of requests) assert.equal(isAllowed({ host: r.url.host }), true, r.url.host);
	assert.equal(new Set(requests.map((r) => r.url.host)).size, 1);
	assert.equal(requests[0].url.host, "file-svc.chat.zalo.me");
	// The chunks carry the bytes, in order, as multipart parts.
	const uploaded = Buffer.concat(
		requests.slice(0, 3).map((r) => {
			const boundary = /boundary=(.+)$/.exec(r.headers["content-type"])[1];
			const body = Buffer.from(r.body);
			const start = body.indexOf("\r\n\r\n") + 4;
			return body.subarray(start, body.lastIndexOf(`\r\n--${boundary}--`));
		}),
	);
	assert.ok(uploaded.equals(data));
});

test("a file waits for the listener's file_done, then is posted as a file", async () => {
	const data = Buffer.from("%PDF-1.4 nội dung");
	const { requests, fetch } = recorder((path) => (path.endsWith("/upload") ? zaloAnswer({ fileId: 55 }) : zaloAnswer({ msgId: 901 })));
	const { api, ctx } = offlineApi(fetch);
	const sending = sendMedia(api, "123", doc(data), data);
	while (!ctx.uploadCallbacks.has("55")) await new Promise((r) => setTimeout(r, 2));
	ctx.uploadCallbacks.get("55")({ fileUrl: "https://f", fileId: 55 });
	const sent = await sending;
	assert.equal(sent.msgId, "901");
	assert.deepEqual(
		requests.map((r) => r.url.pathname),
		["/api/message/asyncfile/upload", "/api/message/asyncfile/msg"],
	);
});

test("an upload that never ends fails as upload_failed and posts nothing, even when it ends later", async () => {
	const data = Buffer.from("x");
	const { requests, fetch } = recorder((path) => (path.endsWith("/upload") ? zaloAnswer({ fileId: 56 }) : zaloAnswer({ msgId: 902 })));
	const { api, ctx } = offlineApi(fetch);
	assert.deepEqual(await failureOf(sendMedia(api, "123", doc(data), data)), { code: "upload_failed" });
	ctx.uploadCallbacks.get("56")?.({ fileUrl: "https://f", fileId: 56 });
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(
		requests.map((r) => r.url.pathname),
		["/api/message/asyncfile/upload"],
	);
});

test("upload failures say nothing was created, by cause", async () => {
	const data = Buffer.from("x");
	const answers = {
		throttled: () => new Response("", { status: 429 }),
		revoked: () => new Response("", { status: 401 }),
		refused: () => new Response(JSON.stringify({ error_code: 114, error_message: "secret server text" }), { status: 200 }),
		broken: () => new Response("", { status: 502 }),
	};
	const want = {
		throttled: { code: "rate_limited" },
		revoked: { code: "session_rejected" },
		refused: { code: "refused", zaloCode: 114 },
		broken: { code: "upload_failed" },
	};
	for (const [name, answer] of Object.entries(answers)) {
		const { api } = offlineApi(async () => answer());
		const failure = await failureOf(sendMedia(api, "123", doc(data), data));
		assert.deepEqual(failure, want[name], name);
		assert.ok(!JSON.stringify(failure).includes("secret"));
	}
	const { api: small } = offlineApi(async () => zaloAnswer({}), { maxSizeMb: 1 });
	const big = Buffer.alloc(2 * 1024 * 1024);
	assert.deepEqual(await failureOf(sendMedia(small, "123", doc(big), big)), { code: "too_large" });
	const { api } = offlineApi(async () => zaloAnswer({}));
	const exe = { ...doc(data), name: "setup.exe" };
	assert.deepEqual(await failureOf(sendMedia(api, "123", exe, data)), { code: "file_refused" });
});

test("a post without a message id leaves the outcome open", async () => {
	const data = Buffer.from("x");
	const { fetch } = recorder((path) => (path.endsWith("/upload") ? zaloAnswer({ photoId: 1, normalUrl: "u", hdUrl: "u", thumbUrl: "u" }) : zaloAnswer({})));
	const { api } = offlineApi(fetch);
	assert.deepEqual(await failureOf(sendMedia(api, "123", photo(data), data)), { code: "unclear" });
});

test("the chunks of a file are joined in order, and a bad or oversized stream is spoiled", () => {
	const uploads = createUploads();
	uploads.chunk("r1", Buffer.from("xin ").toString("base64"));
	uploads.chunk("r1", Buffer.from("chào").toString("base64"));
	assert.equal(uploads.take("r1").toString(), "xin chào");
	assert.equal(uploads.take("r1"), null, "taken once");
	uploads.chunk("r2", Buffer.from("cũ").toString("base64"));
	uploads.chunk("r3", Buffer.from("mới").toString("base64"));
	assert.equal(uploads.take("r2"), null, "another id started over");
	uploads.chunk("r4", "not base64!");
	uploads.chunk("r4", Buffer.from("x").toString("base64"));
	assert.equal(uploads.take("r4"), null);
	const part = Buffer.alloc(768 * 1024).toString("base64");
	for (let sent = 0; sent <= MAX_FILE_BYTES; sent += 768 * 1024) uploads.chunk("r5", part);
	assert.equal(uploads.take("r5"), null);
});

test("send_media is checked: a photo by its name and size, a file without a caption, no video or animation", () => {
	const good = { kind: "photo", name: "a.png", size: 3, width: 1, height: 1, text: "chú thích" };
	assert.notEqual(fileOf(good), null);
	assert.notEqual(fileOf({ kind: "file", name: "a.pdf", size: 3 }), null);
	for (const bad of [
		{ ...good, name: "a.pdf" },
		{ ...good, width: 0 },
		{ ...good, size: MAX_FILE_BYTES + 1 },
		{ ...good, size: 0 },
		{ ...good, name: "../a.png" },
		{ ...good, name: 'a".png' },
		{ ...good, name: "a\n.png" },
		{ kind: "file", name: "a.pdf", size: 3, text: "chú thích" },
		{ kind: "file", name: "a.jpg", size: 3 },
		{ kind: "file", name: "v.MP4", size: 3 },
		{ kind: "file", name: "a.gif", size: 3 },
		{ kind: "video", name: "v.mov", size: 3 },
	]) {
		assert.equal(fileOf(bad), null, JSON.stringify(bad));
	}
});

test("the stand-in form-data builds one multipart body and keeps header values on one line", () => {
	const form = new FormData();
	form.append("chunkContent", Buffer.from("abc"), { filename: 'a"\r\nb.txt', contentType: "application/octet-stream" });
	const boundary = form.getBoundary();
	assert.deepEqual(form.getHeaders(), { "content-type": `multipart/form-data; boundary=${boundary}` });
	assert.equal(
		form.getBuffer().toString(),
		`--${boundary}\r\nContent-Disposition: form-data; name="chunkContent"; filename="a___b.txt"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n--${boundary}--\r\n`,
	);
	assert.throws(() => form.append("x", "text"), TypeError);
});

test("the upload paths and messages the code relies on are in the bundled zca-js, and the stand-in form-data is bundled", async () => {
	const bundle = await readFile(new URL("../dist/zalo-sidecar.cjs", import.meta.url), "utf8");
	for (const literal of [
		'image: "photo_original/upload"',
		'others: "asyncfile/upload"',
		'image: "photo_original/send?"',
		'others: "asyncfile/msg?"',
		"const serviceURL = `${api2.zpwServiceMap.file[0]}/api`;",
		"await api2.uploadAttachment(attachments, threadId, type)",
		"ctx.uploadCallbacks.set(resData.fileId.toString(), uploadCallback)",
		"size exceed maximum size of ${sharefile.max_size_share_file_v3}MB`",
		"throw new ZaloApiError(`File extension \"${extFile}\" is not allowed`)",
		'const isBuffer = typeof source == "object" && source.data instanceof Buffer;',
		"form-data: only bytes can be appended in this build",
	]) {
		assert.ok(bundle.includes(literal), `bundle no longer contains ${literal}`);
	}
	assert.ok(!bundle.includes("file upload is disabled in this build"));
});
