// Web Push end to end on the real server: An's browser session registers a
// push subscription through PushService (as the settings switch does after
// PushManager.subscribe, which headless Chromium cannot reach FCM for), with
// keys made here; the e2e stack accepts a push receiver on loopback
// (WEB_PUSH_ALLOW_LOCAL). Chi writes to An:
//
// - while An has the app in the foreground: no push (the app shows it);
// - once An's tab is closed: one push, VAPID-signed for the receiver's
//   origin, RFC 8291 encrypted; decrypted here it names Chi and the text;
// - with "Hiện nội dung tin" off for private chats: only the app name and
//   "Bạn có tin nhắn mới";
// - after An turns pushes off for the device: nothing.
//
//   pnpm e2e web-push
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { launch, scenario, send, signIn, startPrivateChat, WEB_ORIGIN, type Person } from "./people.ts";

interface Received {
	readonly headers: IncomingMessage["headers"];
	readonly body: Buffer;
}

let browser: Browser;
let an: Person;
let chi: Person;
let receiver: Server;
let pushOrigin = "";
const received: Received[] = [];

before(async () => {
	receiver = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({ headers: req.headers, body: Buffer.concat(chunks) });
			res.writeHead(201).end();
		});
	});
	await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
	pushOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
	browser = await launch();
	an = await signIn(browser, "an");
	chi = await signIn(browser, "chi");
});
after(async () => {
	await browser.close();
	receiver.close();
});

/** A PushService call as An's session (the context's cookie), over Connect JSON. */
async function asAn(method: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await an.context.request.post(`${WEB_ORIGIN}/rpc/app.v1.${method}`, {
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		data: JSON.stringify(body),
	});
	const text = await response.text();
	assert.equal(response.status(), 200, `${method}: ${text}`);
	return JSON.parse(text) as Record<string, unknown>;
}

/** RFC 8291 decryption as the browser does it; returns the payload. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer): unknown {
	const salt = body.subarray(0, 16);
	assert.equal(body.readUInt32BE(16), 4096);
	const idLen = body[20] ?? 0;
	const asPublic = body.subarray(21, 21 + idLen);
	const secret = ua.computeSecret(asPublic);
	const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
	const ikm = Buffer.from(hkdfSync("sha256", secret, auth, info, 32));
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const sealed = body.subarray(21 + idLen);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	const end = plain.lastIndexOf(2);
	assert.ok(end >= 0 && plain.subarray(end + 1).every((byte) => byte === 0), "record delimiter and zero padding");
	return JSON.parse(plain.subarray(0, end).toString("utf8"));
}

/** Checks the VAPID Authorization header: ES256 over the token, by the server's key, for the receiver's origin. */
function checkVapid(header: string | undefined, serverKey: Buffer): void {
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? "");
	assert.ok(match, `Authorization ${header}`);
	const [, jwt = "", k = ""] = match;
	assert.deepEqual(Buffer.from(k, "base64url"), serverKey);
	const [head = "", claims = "", signature = ""] = jwt.split(".");
	const key = createPublicKey({
		key: { kty: "EC", crv: "P-256", x: serverKey.subarray(1, 33).toString("base64url"), y: serverKey.subarray(33).toString("base64url") },
		format: "jwk",
	});
	assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
	const decoded = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { aud: string; exp: number; sub: string };
	assert.equal(decoded.aud, pushOrigin);
	assert.ok(decoded.exp * 1000 > Date.now() && decoded.exp * 1000 < Date.now() + 24 * 3600 * 1000);
}

async function waitForPushes(count: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (received.length < count) {
		if (Date.now() > deadline) throw new Error(`waited for ${count} pushes, got ${received.length}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** No push within a while (the consumer runs within a second of a commit). */
async function noPushBeyond(count: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 2500));
	assert.equal(received.length, count, "unexpected push");
}

scenario("a closed app gets an encrypted push; open app, hidden text and turned off behave", () => [chi], async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = randomBytes(16);
	const config = await asAn("PushService/GetWebPushConfig", {});
	const serverKey = Buffer.from(String(config.applicationServerKey), "base64");
	assert.equal(serverKey.length, 65);
	await asAn("PushService/RegisterWebPush", {
		endpoint: `${pushOrigin}/push/an`,
		p256dh: ua.getPublicKey().toString("base64"),
		auth: auth.toString("base64"),
		locale: "vi",
	});
	assert.equal((await asAn("PushService/GetWebPushConfig", {})).endpoint, `${pushOrigin}/push/an`);

	// An has the app open in the foreground: the app shows it, no push.
	await startPrivateChat(chi, "an");
	await send(chi, "Tin khi An đang mở app");
	await noPushBeyond(0);

	// An closes the tab: the next message comes as a push.
	await an.page.close();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await send(chi, "Tin khi An đã đóng app");
	await waitForPushes(1);
	const first = received[0];
	assert.ok(first);
	assert.equal(first.headers["content-encoding"], "aes128gcm");
	assert.equal(first.headers.ttl, "86400");
	assert.equal(first.headers.urgency, "high");
	assert.match(String(first.headers.topic), /^chat\d+$/);
	assert.ok(!first.body.includes(Buffer.from("Tin khi An đã đóng app")), "text in clear on the wire");
	checkVapid(first.headers.authorization, serverKey);
	const payload = decrypt(first.body, ua, auth) as { chat_id: number; title: string; body: string; tag: string; url: string };
	assert.equal(payload.title, "Chi");
	assert.equal(payload.body, "Tin khi An đã đóng app");
	assert.equal(payload.tag, `chat:${payload.chat_id}`);
	assert.equal(payload.url, `/c/${payload.chat_id}`);
	assert.equal(String(first.headers.topic), `chat${payload.chat_id}`);

	// "Hiện nội dung tin" off for private chats: the app name and a generic text.
	await asAn("ChatsService/SetNotificationSettings", { privatePreview: false });
	await send(chi, "Tin bí mật");
	await waitForPushes(2);
	const hidden = decrypt(received[1]?.body ?? Buffer.alloc(0), ua, auth) as { title: string; body: string };
	assert.equal(hidden.body, "Bạn có tin nhắn mới");
	assert.notEqual(hidden.title, "Chi");
	await asAn("ChatsService/SetNotificationSettings", { privatePreview: true });

	// Turned off for the device: nothing more.
	await asAn("PushService/UnregisterWebPush", {});
	await send(chi, "Tin sau khi tắt");
	await noPushBeyond(2);
});
