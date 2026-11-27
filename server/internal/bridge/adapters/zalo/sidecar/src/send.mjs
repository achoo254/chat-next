// Sending a text message to one person, and why a send failed, as a code the engine can act on.
// Like login-failure.mjs, the library's messages are read here and never leave the process: they
// can embed a raw server response. Neither the text nor the recipient is ever written to stderr.
//
// zca-js 2.3.0 `api.sendMessage(message, threadId, type = ThreadType.User)` with a text-only
// message makes exactly one request: POST <zpwServiceMap.chat[0]>/api/message/sms (the chat host
// comes from Zalo's service map at login). It answers `{ message: { msgId }, attachment: [] }`.
// The client id it sends is `Date.now()` inside the library and is not returned, so a send
// carries no `cliMsgId`; the engine matches a repeated send by what it heard instead.
import { ThreadType } from "zca-js";
import { isNetworkError } from "./login-failure.mjs";

/** Zalo throttled the account (HTTP 429): nothing was created; wait before the next send. */
export const RATE_LIMITED = "rate_limited";
/** Zalo refused the session (HTTP 401/403): nothing was created. */
export const SESSION_REJECTED = "session_rejected";
/** Zalo answered with an error code of its own (blocked, not allowed, ...): nothing was created. */
export const REFUSED = "refused";
/** The command or the library refused the message before anything was sent. */
export const BAD_REQUEST = "bad_request";
/** No account is logged in yet in this process: nothing was sent. */
export const NOT_LOGGED_IN = "not_logged_in";
/** The connection failed: the request may or may not have reached Zalo. */
export const NETWORK_ERROR = "network_error";
/** Zalo answered with another HTTP error: the message may or may not exist. */
export const ZALO_UNAVAILABLE = "zalo_unavailable";
/** Anything else, an answer without a message id included: the message may or may not exist. */
export const UNCLEAR = "unclear";

/** Errors the library throws before any request leaves the process. */
const LOCAL_MESSAGES = new Set(["Missing message content", "Missing threadId", "Failed to encrypt message"]);
const HTTP_FAILED = "Request failed with status code ";

/** A recipient id: the decimal user id of a 1-1 chat. */
export function isUserId(value) {
	return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

/** A request id of the engine, echoed back in the answer. */
export function isRequestId(value) {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
}

/** Thrown when Zalo accepted the request but named no message: it may exist. */
class NoMessageIdError extends Error {
	constructor() {
		super("no message id");
		this.name = "NoMessageIdError";
	}
}

/**
 * Sends `text` to the user (or, with `type` ThreadType.Group, the group) `to` and returns the id Zalo
 * gave the message and when it answered. To a group the request is POST <zpwServiceMap.group[0]>/api/group/sendmsg.
 */
export async function sendText(api, to, text, type = ThreadType.User) {
	const result = await api.sendMessage({ msg: text }, to, type);
	const id = result?.message?.msgId;
	const msgId = typeof id === "number" || typeof id === "string" ? String(id) : "";
	if (!/^[0-9]{1,30}$/.test(msgId)) throw new NoMessageIdError();
	return { msgId, ts: Date.now() };
}

/** The code (and Zalo's own numeric code, when it gave one) for an error thrown by sendText. */
export function sendFailure(error) {
	if (error === null || typeof error !== "object") return { code: UNCLEAR };
	if (error.name === "ZcaApiError") {
		const message = typeof error.message === "string" ? error.message : "";
		if (message.startsWith(HTTP_FAILED)) {
			const status = Number(message.slice(HTTP_FAILED.length));
			if (status === 429) return { code: RATE_LIMITED };
			if (status === 401 || status === 403) return { code: SESSION_REJECTED };
			return { code: ZALO_UNAVAILABLE };
		}
		if (LOCAL_MESSAGES.has(message) || message.startsWith("Invalid mentions")) return { code: BAD_REQUEST };
		const zaloCode = Number(error.code);
		if (error.code !== null && Number.isInteger(zaloCode)) return { code: REFUSED, zaloCode };
		return { code: UNCLEAR };
	}
	return { code: isNetworkError(error) ? NETWORK_ERROR : UNCLEAR };
}
