// Reacting to one message of a 1-1 chat. zca-js 2.3.0 `api.addReaction(icon, { data: { msgId, cliMsgId },
// threadId, type })` makes exactly one request: POST <zpwServiceMap.reaction[0]>/api/message/reaction.
// `icon` is one of the codes of `Reactions` (":o", "/-heart", ...); "" takes the owner's reaction back.
// The library reads both ids as integers. Failures are classified like a send's (send.mjs): the
// library's messages are read there and never leave the process, and nothing here is ever logged.
import { Reactions, ThreadType } from "zca-js";

/** The reaction codes Zalo knows, "" (take back) included. */
const CODES = new Set(Object.values(Reactions));

/** Whether `value` is a code of Zalo's reactions. */
export function isReactionCode(value) {
	return typeof value === "string" && CODES.has(value);
}

/** An id of a message: decimal digits. A client id of 0 stands for one the engine does not know. */
export function isMessageId(value) {
	return typeof value === "string" && /^[0-9]{1,30}$/.test(value);
}

/** Sets (or, with icon "", removes) the owner's reaction to the message `msgId` of the person `to`. */
export async function sendReaction(api, to, msgId, cliMsgId, icon) {
	await api.addReaction(icon, { data: { msgId, cliMsgId }, threadId: to, type: ThreadType.User });
}
