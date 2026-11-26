// The Zalo sidecar of Chat Bridge: one process per Zalo account, spoken to over stdio.
//
// stdin  : one JSON command per line.
//   {"cmd":"login_qr","listen":false}        log in by QR; the QR image comes back as an event.
//                                            listen:false (protocol 3) ends at `account` without
//                                            starting the listener; absent or true also listens
//   {"cmd":"login_session","session":{...}}  log in with a session an earlier login returned
//   {"cmd":"send","id":"<req id>","to":"<uid digits>","text":".."}  (protocol 4) send one text message
//                                            to one person (1-1 only); answered by `sent` or `send_error`
//   {"cmd":"history","id":"<req id>","peer":"<uid digits>"}  (protocol 4) the newest page of 1-1
//                                            messages, cut down to that person; `history` or `history_error`
//   {"cmd":"file_chunk","id":"<req id>","data":"<base64>"}  (protocol 8) the next bytes of the file of the
//                                            send_media command with the same id; no answer
//   {"cmd":"send_media","id":"<req id>","to":"<uid digits>","kind":"photo"|"file","name":"..","size":<bytes>,
//    "width":..,"height":..,"text":".."}    (protocol 8) send the file streamed under id (at most 25 MiB) to one
//                                            person, a caption only with a photo (src/send-media.mjs);
//                                            answered by `sent` or `send_error`
//   {"cmd":"react","id":"<req id>","to":"<uid digits>","msgId":"<digits>","cliMsgId":"<digits>","icon":".."}
//                                            (protocol 9) set the owner's reaction to one message of one person
//                                            to the Zalo reaction code icon, "" taking it back (src/reaction.mjs);
//                                            answered by `reacted` or `send_error`
//   {"cmd":"undo","id":"<req id>","to":"<uid digits>","msgId":"<digits>","cliMsgId":"<digits>"}
//                                            (protocol 10) recall one message the owner sent to one person, for
//                                            everyone (src/undo.mjs); answered by `undone` or `send_error`
//   {"cmd":"stop"}                           stop listening and exit
// stdout : one JSON event per line, and nothing else (the library's own logging is off).
//   {"ev":"ready","protocol":7}
//   {"ev":"qr","image":"<base64 png>"} | {"ev":"qr_scanned"} | {"ev":"qr_expired"} | {"ev":"qr_declined"}
//   {"ev":"logged_in","session":{cookie,imei,userAgent}}   the engine keeps it (encrypted), never this process
//   {"ev":"account","uid":"<digits>"}                the signed-in account, once logged in (both ways);
//                                                    an id that is not 1-20 digits is error no_account
//   {"ev":"message","thread":"user"|"group","self":bool,"msgType":..,"content":..,"msgId":..,"cliMsgId":..,"uidFrom":..,"idTo":..,"dName":..,"ts":..,"ttl":..,
//    "peerName":..,"peerAvatar":..,"peerSeen":..}   1-1 only: peerName is the other person's name for a
//                                     message the owner sent; peerAvatar (protocol 6) the https URL of their
//                                     photo; peerSeen (protocol 11) when they were last online, ms, 0 when unknown;
//                                     the phone number of their profile is not passed on (protocol 12)
//   {"ev":"event","name":"typing"|"reaction"|"undo"|"seen"|"delivered"|..,"payload":..}
//   {"ev":"listener","state":"connected"|"disconnected"|"closed","code":..}
//   {"ev":"sent","id":..,"msgId":"<digits>","ts":<ms>}    ts is this process's clock when Zalo answered
//   {"ev":"send_error","id":..,"code":"..","zaloCode":<int>?}  src/send.mjs: codes that say nothing was
//     created (rate_limited, session_rejected, refused, bad_request, not_logged_in; for send_media also
//     too_large, file_refused, upload_failed) and codes that leave it open (network_error,
//     zalo_unavailable, unclear); zaloCode only with refused
//   {"ev":"history","id":..,"count":<page size>,"oldestTs":<ms>,"messages":[{self,msgType,textHash,msgId,ts}]}
//     textHash: SHA-256 hex of a text message's text (src/history.mjs), null for any other message
//   {"ev":"history_error","id":..,"code":"listener_down"|"busy"|"timeout"|"failed"}
//   {"ev":"error","code":"..","message":".."}          sanitised: never a raw server response. A failed
//     login's code says why (src/login-failure.mjs): session_rejected, zalo_unavailable,
//     network_error, bad_session, login_failed; message is only the error's class name.
// Never called: sendSeenEvent, sendDeliveredEvent, sendTypingEvent, addReaction, findUser,
// getMultiUsersByPhones. Nothing is sent to a group.
// stderr : operational lines only: `host <name>` once per Zalo host connected to (the firewall's
//          learning run reads them), `blocked ...` for a refused connection. No message text,
//          cookie, imei, name, phone number or id is ever written here. `lookup ok|empty|failed` says only how a
//          name lookup of the other person of a 1-1 chat ended.
//
// Nothing here writes a file, spawns a process or reads the environment. src/ws-env.mjs sets the
// two ws switches itself: the engine starts the sidecar through sudo, which resets the environment.
// First, before anything that loads ws: sudo resets the environment (src/ws-env.mjs).
import "./ws-env.mjs";
import readline from "node:readline";
import { setTimeout } from "node:timers";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import { installEgressGuard } from "./egress-guard.mjs";
import { createHistory, HistoryError } from "./history.mjs";
import { createPeerLookup } from "./peer-profile.mjs";
import { BadSessionError, loginFailureReason } from "./login-failure.mjs";
import { BAD_REQUEST, isRequestId, isUserId, NOT_LOGGED_IN, sendFailure, sendText } from "./send.mjs";
import { sendUndo } from "./undo.mjs";
import { isMessageId, isReactionCode, sendReaction } from "./reaction.mjs";
import { createUploads, fileOf, guardUploads, sendMedia, sendMediaFailure } from "./send-media.mjs";

// 2: adds the `account` event (the engine needs the account id to finish a QR login).
// 3: login_qr can skip the listener; login failures carry a reason code; the uid is checked.
// 4: send (text, 1-1) and history; old_messages is no longer forwarded as an event (history reads it).
// 5: a history message carries the hash of its text (textHash), not the text.
// 6: a 1-1 message carries the other person's photo URL (peerAvatar); the profile is looked up for every 1-1 message.
// 7: (retired in 12) a 1-1 message carried the phone number the other person's profile shows (peerPhone).
// 8: file_chunk and send_media send one photo or file to one person.
// 9: react sets or takes back the owner's reaction to a message; a history message carries its client id (cliMsgId).
// 10: undo recalls a message the owner sent.
// 11: a 1-1 message carries when the other person was last online (peerSeen, ms; 0 when unknown).
// 12: a 1-1 message no longer carries the other person's phone number (peerPhone is gone).
const PROTOCOL = 12;

/** How long a history request waits for its page. */
const HISTORY_TIMEOUT_MS = 10_000;

installEgressGuard({
	onHost: (host) => process.stderr.write(`host ${host}\n`),
	onBlocked: (target) => process.stderr.write(`blocked ${target.path !== undefined ? "unix-socket" : target.host}\n`),
});

/** The only writer of stdout. */
function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** An error the engine can act on, without anything the server sent. */
function fail(code, error) {
	emit({ ev: "error", code, message: error instanceof Error ? error.name : "error" });
}

// logging and the npm version check are off: the first prints names to stdout, the second calls
// registry.npmjs.org on every login. selfListen departs from the audit's advice (false) on
// purpose: without it the owner's own messages, sent from the phone, never reach Chat.
const zalo = new Zalo({ logging: false, checkUpdate: false, selfListen: true });
let api = null;
/** The bytes of the file being streamed for a send_media command. */
const uploads = createUploads();
/** Whether the websocket listener is connected (a history request needs it). */
let connected = false;
/** Pages of old messages; set once the listener starts. */
let history = null;

/** What the websocket listener reports besides messages, and the label the engine sees. */
const FORWARDED = {
	typing: "typing",
	reaction: "reaction",
	undo: "undo",
	seen_messages: "seen",
	delivered_messages: "delivered",
	group_event: "group_event",
	friend_event: "friend_event",
};

/** Says which account signed in; false (and an error) when the library gives no usable id. */
function announce(loggedIn) {
	const uid = loggedIn.getOwnId();
	const text = typeof uid === "number" || typeof uid === "string" ? String(uid) : "";
	if (!/^[0-9]{1,20}$/.test(text)) {
		emit({ ev: "error", code: "no_account", message: "error" });
		return false;
	}
	emit({ ev: "account", uid: text });
	return true;
}

/** Lookups of the other person of a 1-1 message (src/peer-profile.mjs); stderr says only how each ended. */
let lookupPeer = null;

/** Keeps the logged-in API; its uploads get a time limit (src/send-media.mjs). */
function useApi(loggedIn) {
	guardUploads(loggedIn);
	api = loggedIn;
}

/** Starts the websocket listener of a logged-in API and forwards what it hears. */
function listen(loggedIn) {
	useApi(loggedIn);
	lookupPeer = createPeerLookup({
		getUserInfo: (uid) => loggedIn.getUserInfo(uid),
		getLastOnline: (uid) => loggedIn.lastOnline(uid),
		log: (outcome) => process.stderr.write(`lookup ${outcome}\n`),
	});
	api.listener.on("message", async (message) => {
		const data = message.data ?? {};
		const isGroup = message.type === ThreadType.Group;
		const self = Boolean(message.isSelf);
		const peerUid = String(self ? (data.idTo ?? "") : (data.uidFrom ?? ""));
		const peer = !isGroup && /^[0-9]{1,20}$/.test(peerUid) ? await lookupPeer(peerUid) : { name: "", avatar: "", seen: 0 };
		emit({
			ev: "message",
			thread: isGroup ? "group" : "user",
			self,
			peerName: self ? peer.name : "",
			peerAvatar: peer.avatar,
			peerSeen: peer.seen,
			msgType: data.msgType,
			content: data.content,
			msgId: data.msgId,
			cliMsgId: data.cliMsgId,
			uidFrom: data.uidFrom,
			idTo: data.idTo,
			dName: data.dName,
			ts: data.ts,
			ttl: data.ttl,
		});
	});
	for (const [name, label] of Object.entries(FORWARDED)) api.listener.on(name, (payload) => emit({ ev: "event", name: label, payload }));
	history = createHistory(api.listener, { isConnected: () => connected, timeoutMs: HISTORY_TIMEOUT_MS });
	api.listener.on("connected", () => {
		connected = true;
		emit({ ev: "listener", state: "connected" });
	});
	api.listener.on("disconnected", (code) => {
		connected = false;
		emit({ ev: "listener", state: "disconnected", code });
	});
	api.listener.on("closed", (code) => {
		connected = false;
		emit({ ev: "listener", state: "closed", code });
	});
	api.listener.on("error", (error) => fail("listener_error", error));
	api.listener.start();
}

async function loginQR(listenAfter) {
	// A callback is always given: without one the library writes qr.png into the working directory.
	const loggedIn = await zalo.loginQR({}, (event) => {
		switch (event.type) {
			case LoginQRCallbackEventType.QRCodeGenerated:
				emit({ ev: "qr", image: event.data?.image });
				break;
			case LoginQRCallbackEventType.QRCodeScanned:
				emit({ ev: "qr_scanned" });
				break;
			case LoginQRCallbackEventType.QRCodeExpired:
				emit({ ev: "qr_expired" });
				break;
			case LoginQRCallbackEventType.QRCodeDeclined:
				emit({ ev: "qr_declined" });
				break;
			case LoginQRCallbackEventType.GotLoginInfo:
				emit({ ev: "logged_in", session: event.data });
				break;
		}
	});
	if (!announce(loggedIn)) return;
	if (listenAfter) listen(loggedIn);
	else useApi(loggedIn);
}

async function loginSession(session) {
	if (session === null || typeof session !== "object" || !session.cookie || !session.imei || !session.userAgent) {
		throw new BadSessionError();
	}
	const loggedIn = await zalo.login({ cookie: session.cookie, imei: session.imei, userAgent: session.userAgent });
	if (announce(loggedIn)) listen(loggedIn);
}

/** Sends one text message; the answer carries the engine's request id, never the text. */
async function send(command) {
	const id = command.id;
	if (api === null) return emit({ ev: "send_error", id, code: NOT_LOGGED_IN });
	if (!isUserId(command.to) || typeof command.text !== "string" || command.text === "") {
		return emit({ ev: "send_error", id, code: BAD_REQUEST });
	}
	try {
		const { msgId, ts } = await sendText(api, command.to, command.text);
		emit({ ev: "sent", id, msgId, ts });
	} catch (error) {
		emit({ ev: "send_error", id, ...sendFailure(error) });
	}
}

/** Sends the photo or file streamed under the command's id; the answer never carries the file or its name. */
async function sendFile(command) {
	const id = command.id;
	const data = uploads.take(id);
	if (api === null) return emit({ ev: "send_error", id, code: NOT_LOGGED_IN });
	const file = fileOf(command);
	if (!isUserId(command.to) || file === null || data === null || data.length !== file.size) {
		return emit({ ev: "send_error", id, code: BAD_REQUEST });
	}
	try {
		const { msgId, ts } = await sendMedia(api, command.to, file, data);
		emit({ ev: "sent", id, msgId, ts });
	} catch (error) {
		emit({ ev: "send_error", id, ...sendMediaFailure(error) });
	}
}

/** Sets or takes back the owner's reaction to one message; the answer never carries more than the request id. */
async function react(command) {
	const id = command.id;
	if (api === null) return emit({ ev: "send_error", id, code: NOT_LOGGED_IN });
	if (!isUserId(command.to) || !isMessageId(command.msgId) || !isMessageId(command.cliMsgId) || !isReactionCode(command.icon)) {
		return emit({ ev: "send_error", id, code: BAD_REQUEST });
	}
	try {
		await sendReaction(api, command.to, command.msgId, command.cliMsgId, command.icon);
		emit({ ev: "reacted", id });
	} catch (error) {
		emit({ ev: "send_error", id, ...sendFailure(error) });
	}
}

/** Recalls one message the owner sent; the answer never carries more than the request id. */
async function undo(command) {
	const id = command.id;
	if (api === null) return emit({ ev: "send_error", id, code: NOT_LOGGED_IN });
	if (!isUserId(command.to) || !isMessageId(command.msgId) || !isMessageId(command.cliMsgId)) {
		return emit({ ev: "send_error", id, code: BAD_REQUEST });
	}
	try {
		await sendUndo(api, command.to, command.msgId, command.cliMsgId);
		emit({ ev: "undone", id });
	} catch (error) {
		emit({ ev: "send_error", id, ...sendFailure(error) });
	}
}

/** Reads the newest page of 1-1 messages for one person. */
async function readHistory(command) {
	const id = command.id;
	if (history === null) return emit({ ev: "history_error", id, code: "listener_down" });
	if (!isUserId(command.peer)) return emit({ ev: "history_error", id, code: "failed" });
	try {
		emit({ ev: "history", id, ...(await history.read(command.peer)) });
	} catch (error) {
		emit({ ev: "history_error", id, code: error instanceof HistoryError ? error.code : "failed" });
	}
}

async function handle(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return fail("bad_command", new Error("bad json"));
	}
	if (command === null || typeof command !== "object") return fail("bad_command", new Error("bad json"));
	try {
		switch (command.cmd) {
			case "login_qr":
				return await loginQR(command.listen !== false);
			case "login_session":
				return await loginSession(command.session);
			case "file_chunk":
				// Kept before anything awaits, so the chunks of a file are in order when send_media reads them.
				if (!isRequestId(command.id)) return fail("bad_command", new Error("bad id"));
				return uploads.chunk(command.id, command.data);
			case "send":
			case "history":
			case "send_media":
			case "react":
			case "undo":
				if (!isRequestId(command.id)) return fail("bad_command", new Error("bad id"));
				if (command.cmd === "send") return await send(command);
				if (command.cmd === "react") return await react(command);
				if (command.cmd === "undo") return await undo(command);
				return command.cmd === "send_media" ? await sendFile(command) : await readHistory(command);
			case "stop":
				api?.listener.stop();
				return setTimeout(() => process.exit(0), 200);
			default:
				return fail("unknown_command", new Error("unknown"));
		}
	} catch (error) {
		// A login says why it failed; the library's message never leaves the process.
		const login = command.cmd === "login_qr" || command.cmd === "login_session";
		return fail(login ? loginFailureReason(error) : "command_failed", error);
	}
}

// The engine closing our stdin is the signal to stop: no orphan survives it.
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => void handle(line));
lines.on("close", () => {
	api?.listener.stop();
	setTimeout(() => process.exit(0), 200);
});
process.on("uncaughtException", (error) => {
	fail("uncaught", error);
	process.exit(1);
});
process.on("unhandledRejection", (error) => {
	fail("unhandled", error);
	process.exit(1);
});
emit({ ev: "ready", protocol: PROTOCOL });
