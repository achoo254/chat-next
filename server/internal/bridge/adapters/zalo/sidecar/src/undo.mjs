// Recalling (undoing) one message the owner sent to a person, for everyone. zca-js 2.3.0
// `api.undo({ msgId, cliMsgId }, threadId, ThreadType.User)` makes exactly one request:
// POST <zpwServiceMap.chat[0]>/api/message/undo, a host the egress guard and the firewall
// already allow for sending. Both ids are passed as the decimal strings the listener gave
// (a message id can be larger than a JavaScript number holds exactly). Failures are classified
// like a send's (send.mjs); nothing here is logged.
import { ThreadType } from "zca-js";

/** Recalls the message `msgId` (client id `cliMsgId`, "0" when unknown) the owner sent to the person `to`. */
export async function sendUndo(api, to, msgId, cliMsgId) {
	await api.undo({ msgId, cliMsgId }, to, ThreadType.User);
}
