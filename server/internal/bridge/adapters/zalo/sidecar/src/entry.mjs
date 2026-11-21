// The Zalo sidecar of Chat Bridge: one process per Zalo account, spoken to over stdio.
//
// stdin  : one JSON command per line.
//   {"cmd":"login_qr","listen":false}        log in by QR; the QR image comes back as an event.
//                                            listen:false (protocol 3) ends at `account` without
//                                            starting the listener; absent or true also listens
//   {"cmd":"login_session","session":{...}}  log in with a session an earlier login returned
//   {"cmd":"stop"}                           stop listening and exit
// stdout : one JSON event per line, and nothing else (the library's own logging is off).
//   {"ev":"ready","protocol":3}
//   {"ev":"qr","image":"<base64 png>"} | {"ev":"qr_scanned"} | {"ev":"qr_expired"} | {"ev":"qr_declined"}
//   {"ev":"logged_in","session":{cookie,imei,userAgent}}   the engine keeps it (encrypted), never this process
//   {"ev":"account","uid":"<digits>"}                the signed-in account, once logged in (both ways);
//                                                    an id that is not 1-20 digits is error no_account
//   {"ev":"message","thread":"user"|"group","self":bool,"msgType":..,"content":..,"msgId":..,"cliMsgId":..,"uidFrom":..,"idTo":..,"dName":..,"ts":..,"ttl":..}
//   {"ev":"event","name":"typing"|"reaction"|"undo"|"seen"|"delivered"|..,"payload":..}
//   {"ev":"listener","state":"connected"|"disconnected"|"closed","code":..}
//   {"ev":"error","code":"..","message":".."}          sanitised: never a raw server response. A failed
//     login's code says why (src/login-failure.mjs): session_rejected, zalo_unavailable,
//     network_error, bad_session, login_failed; message is only the error's class name.
// stderr : operational lines only: `host <name>` once per Zalo host connected to (the firewall's
//          learning run reads them), `blocked ...` for a refused connection. No message text,
//          cookie, imei, name or id is ever written here.
//
// Nothing here writes a file, spawns a process or reads the environment.
import readline from "node:readline";
import { setTimeout } from "node:timers";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import { installEgressGuard } from "./egress-guard.mjs";
import { BadSessionError, loginFailureReason } from "./login-failure.mjs";

// 2: adds the `account` event (the engine needs the account id to finish a QR login).
// 3: login_qr can skip the listener; login failures carry a reason code; the uid is checked.
const PROTOCOL = 3;

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

/** What the websocket listener reports besides messages, and the label the engine sees. */
const FORWARDED = {
	typing: "typing",
	reaction: "reaction",
	undo: "undo",
	seen_messages: "seen",
	delivered_messages: "delivered",
	old_messages: "old_messages",
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

/** Starts the websocket listener of a logged-in API and forwards what it hears. */
function listen(loggedIn) {
	api = loggedIn;
	api.listener.on("message", (message) => {
		const data = message.data ?? {};
		emit({
			ev: "message",
			thread: message.type === ThreadType.Group ? "group" : "user",
			self: Boolean(message.isSelf),
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
	api.listener.on("connected", () => emit({ ev: "listener", state: "connected" }));
	api.listener.on("disconnected", (code) => emit({ ev: "listener", state: "disconnected", code }));
	api.listener.on("closed", (code) => emit({ ev: "listener", state: "closed", code }));
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
	else api = loggedIn;
}

async function loginSession(session) {
	if (session === null || typeof session !== "object" || !session.cookie || !session.imei || !session.userAgent) {
		throw new BadSessionError();
	}
	const loggedIn = await zalo.login({ cookie: session.cookie, imei: session.imei, userAgent: session.userAgent });
	if (announce(loggedIn)) listen(loggedIn);
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
