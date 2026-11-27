// A real zca-js 2.3.0 API object that never leaves the process, for tests that check which request
// a call makes. `fetch` answers every request; zaloAnswer builds the encrypted envelope it expects.
import crypto from "node:crypto";
import { API } from "zca-js";

const key = crypto.randomBytes(16);

/** Zalo's answer envelope: `data` encrypted with the session key, as the library expects it. */
export function zaloAnswer(inner) {
	const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
	const data = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]).toString("base64");
	return new Response(JSON.stringify({ error_code: 0, data }), { status: 200 });
}

/** Every service of the map points at `<service>-svc.<domain>` (the real map comes from Zalo at login). */
export function offlineApi(fetch, domain = "chat.zalo.me") {
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
