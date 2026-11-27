// The recent messages of one 1-1 chat, read so the engine can tell whether an earlier send went
// out. zca-js 2.3.0 has one call for it: `listener.requestOldMessages(ThreadType.User, null)`
// asks the websocket for the newest page of old messages of ALL 1-1 chats (cmd 510, no chat
// filter); the page comes back later as the listener event `old_messages` (messages, ThreadType.User),
// with no request id. So one request is open at a time, the page is cut down to the one chat
// asked for here, and only the shape the engine needs leaves the process: no text, only its
// hash (textHash), so the answer stays one short line whatever the messages say. The page's
// size is Zalo's choice; `oldestTs` (over the whole page) says how far back it reaches.
import { createHash } from "node:crypto";
import { ThreadType } from "zca-js";

/** Most messages of the chat handed back from one page, the newest kept. */
export const MAX_HISTORY_MESSAGES = 50;

/** Why a history request got no page. */
export const LISTENER_DOWN = "listener_down";
export const BUSY = "busy";
export const TIMEOUT = "timeout";

export class HistoryError extends Error {
	constructor(code) {
		super(code);
		this.name = "HistoryError";
		this.code = code;
	}
}

/**
 * Reads pages through `listener`. `isConnected` says whether the websocket is up (a request on a
 * closed one is silently dropped by the library); `timeoutMs` bounds the wait for the page.
 */
export function createHistory(listener, { isConnected, timeoutMs }) {
	let pending = null;
	listener.on("old_messages", (messages, type) => {
		if (pending === null || type !== ThreadType.User) return;
		const { resolve, timer } = pending;
		pending = null;
		clearTimeout(timer);
		resolve(Array.isArray(messages) ? messages : []);
	});
	return {
		/** The page cut down to the 1-1 chat with `peer`. */
		async read(peer) {
			if (!isConnected()) throw new HistoryError(LISTENER_DOWN);
			if (pending !== null) throw new HistoryError(BUSY);
			const messages = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending = null;
					reject(new HistoryError(TIMEOUT));
				}, timeoutMs);
				pending = { resolve, timer };
				listener.requestOldMessages(ThreadType.User, null);
			});
			return pageFor(messages, peer);
		},
	};
}

/**
 * The hash of a text as the engine compares it (hashText in sent_log.go, defined the same way on
 * both sides): SHA-256 of the text's UTF-8 bytes exactly as Zalo gave them, no trimming or
 * normalisation, as lowercase hex.
 */
export function textHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * What the engine gets of a page: the chat's messages and how far back the whole page reaches. A
 * message carries the hash of its text when it is a non-empty text, null otherwise.
 */
export function pageFor(messages, peer) {
	let oldestTs = 0;
	const own = [];
	for (const message of messages) {
		const data = message?.data ?? {};
		const ts = Number(data.ts);
		if (Number.isFinite(ts) && ts > 0 && (oldestTs === 0 || ts < oldestTs)) oldestTs = ts;
		if (String(message?.threadId ?? "") !== peer) continue;
		own.push({
			self: Boolean(message.isSelf),
			msgType: data.msgType,
			textHash: typeof data.content === "string" && data.content !== "" ? textHash(data.content) : null,
			msgId: data.msgId,
			cliMsgId: data.cliMsgId,
			ts: data.ts,
		});
	}
	// The page's order is Zalo's; keep the newest by time.
	own.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
	return { count: messages.length, oldestTs, messages: own.slice(-MAX_HISTORY_MESSAGES) };
}

/** Most messages of a group read for one history request. */
export const GROUP_HISTORY_COUNT = 50;

/**
 * The newest page of the group `groupId`, in the shape of pageFor. zca-js 2.3.0
 * `api.getGroupChatHistory(groupId, count)` makes exactly one request: GET
 * <zpwServiceMap.group[0]>/api/group/history, answered with `{ groupMsgs: [GroupMessage] }`, whose
 * threadId is the group's id. It needs no listener, so one group may be read while another request
 * is open.
 */
export async function readGroupPage(getGroupChatHistory, groupId) {
	const answer = await getGroupChatHistory(groupId, GROUP_HISTORY_COUNT);
	const messages = Array.isArray(answer?.groupMsgs) ? answer.groupMsgs : [];
	return pageFor(messages, groupId);
}
