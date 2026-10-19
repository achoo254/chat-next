import { createPublicKey, verify } from "node:crypto";

/** How old init data `verifyMiniAppInitData` accepts by default, in seconds (its `auth_date`). */
export const MINI_APP_MAX_AGE_S = 3600;
/** How far in the future `auth_date` may be (clock skew), in seconds. */
const FUTURE_SKEW_S = 300;

/** The user who opened the Mini App. */
export interface MiniAppUser {
	readonly id: number;
	readonly first_name: string;
	readonly username?: string;
}

/** Verified init data. */
export interface MiniAppInitData {
	readonly user: MiniAppUser;
	/** `private`, `group`, `channel`, or `sender` (opened from the bot's profile); new types may be added. */
	readonly chat_type: string;
	/** Stable for a chat and the bot (for `sender`: the user and the bot), without telling the chat id. */
	readonly chat_instance: string;
	/** `""` when none was given. */
	readonly start_param: string;
	/** Unix seconds. */
	readonly auth_date: number;
	readonly bot_id: number;
	readonly tenant_id: string;
	/** Every field but `signature`, as received. */
	readonly fields: Readonly<Record<string, string>>;
}

/**
 * Checks the init data a Mini App received (the query string the client
 * passes in `#chatAppData`) and returns its fields, or `null` when it is not
 * genuine. The signature is Ed25519 over `"<bot_id>:WebAppData\n"` followed by
 * the other fields as `key=value` lines sorted by key and joined by `"\n"`,
 * checked with `publicKey` (`client.getMiniAppKey()`, base64url); `bot_id`
 * must be `botId` and `auth_date` at most `maxAgeS` seconds old at `now`.
 */
export function verifyMiniAppInitData(
	initData: string,
	botId: number,
	publicKey: string,
	maxAgeS: number = MINI_APP_MAX_AGE_S,
	now: Date = new Date(),
): MiniAppInitData | null {
	const fields: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(initData)) {
		if (Object.hasOwn(fields, key)) {
			return null;
		}
		fields[key] = value;
	}
	const signature = fields.signature;
	delete fields.signature;
	if (signature === undefined || !/^[A-Za-z0-9_-]{86}$/.test(signature) || fields.bot_id !== String(botId)) {
		return null;
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) {
		return null;
	}
	let ok: boolean;
	try {
		const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
		ok = verify(null, Buffer.from(checkString(botId, fields)), key, Buffer.from(signature, "base64url"));
	} catch {
		return null;
	}
	if (!ok) {
		return null;
	}
	const authDate = /^\d{1,15}$/.test(fields.auth_date ?? "") ? Number(fields.auth_date) : Number.NaN;
	const age = now.getTime() / 1000 - authDate;
	if (!(age <= maxAgeS && age >= -FUTURE_SKEW_S)) {
		return null;
	}
	let user: MiniAppUser;
	try {
		user = JSON.parse(fields.user ?? "") as MiniAppUser;
	} catch {
		return null;
	}
	if (typeof user !== "object" || user === null || typeof user.id !== "number") {
		return null;
	}
	return {
		user,
		chat_type: fields.chat_type ?? "",
		chat_instance: fields.chat_instance ?? "",
		start_param: fields.start_param ?? "",
		auth_date: authDate,
		bot_id: botId,
		tenant_id: fields.tenant_id ?? "",
		fields,
	};
}

/** The signed text of the fields (signature excluded). */
function checkString(botId: number, fields: Readonly<Record<string, string>>): string {
	const lines = Object.keys(fields)
		.sort()
		.map((key) => `${key}=${fields[key]}`);
	return [`${botId}:WebAppData`, ...lines].join("\n");
}
