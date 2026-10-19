import { describe, expect, it } from "vitest";
import { verifyMiniAppInitData } from "../src/index.ts";

// Init data signed by the server (server/internal/miniapp TestSignVector;
// docs/bot-api/README.md).
const KEY = "3ktwc67vmU-jLgKZ13Lj1iN6KAk145mjNELp-vwXrcg";
const INIT_DATA =
	"auth_date=1760850000&bot_id=1234567&chat_instance=jkvivnNpwnmKUPzV&chat_type=private" +
	"&signature=_Z0BDYBsfng_LKrIg5NS1OZZMzOmjLKQU9sXDmE4vYMWAzIZzX8_W_XApoETPJsVzHm-pwST8Goq1Z92Vnu0CQ" +
	"&start_param=promo_1&tenant_id=primary" +
	"&user=%7B%22id%22%3A7654321%2C%22first_name%22%3A%22Lan+Nguy%E1%BB%85n%22%2C%22username%22%3A%22lan%22%7D";
const BOT_ID = 1234567;
const AUTH_DATE = 1760850000;
const at = (seconds: number): Date => new Date((AUTH_DATE + seconds) * 1000);

describe("verifyMiniAppInitData", () => {
	it("accepts init data signed by the server", () => {
		const data = verifyMiniAppInitData(INIT_DATA, BOT_ID, KEY, undefined, at(60));
		expect(data).toMatchObject({
			user: { id: 7654321, first_name: "Lan Nguyễn", username: "lan" },
			chat_type: "private",
			chat_instance: "jkvivnNpwnmKUPzV",
			start_param: "promo_1",
			auth_date: AUTH_DATE,
			bot_id: BOT_ID,
			tenant_id: "primary",
		});
		expect(data?.fields).not.toHaveProperty("signature");
	});

	it.each([
		["another bot", INIT_DATA, BOT_ID + 1, KEY, undefined, at(0)],
		["older than an hour", INIT_DATA, BOT_ID, KEY, undefined, at(3601)],
		["older than max age", INIT_DATA, BOT_ID, KEY, 60, at(120)],
		["from the future", INIT_DATA, BOT_ID, KEY, undefined, at(-600)],
		["tampered", INIT_DATA.replace("chat_type=private", "chat_type=group"), BOT_ID, KEY, undefined, at(0)],
		["field added", `${INIT_DATA}&admin=1`, BOT_ID, KEY, undefined, at(0)],
		["field repeated", `${INIT_DATA}&chat_type=private`, BOT_ID, KEY, undefined, at(0)],
		["another key", INIT_DATA, BOT_ID, `A${KEY.slice(1)}`, undefined, at(0)],
		["bad key", INIT_DATA, BOT_ID, "short", undefined, at(0)],
		["no signature", "auth_date=1760850000&bot_id=1234567", BOT_ID, KEY, undefined, at(0)],
	] as const)("rejects %s", (_name, initData, botId, key, maxAge, now) => {
		expect(verifyMiniAppInitData(initData, botId, key, maxAge, now)).toBeNull();
	});
});
