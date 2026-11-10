// Pairing this device with a machine (ADR 0013). Nothing secret goes through
// the chat server, and the machine key is pinned only after the machine
// proved it: the install secret (one-command install) or the 6-digit
// Authenticator code through CPace. The caller pins the key it gets back.
import {
	HandshakeFailure,
	decodePlain,
	encodePlain,
	pakeStart,
	startHandshake,
	type DeviceTrust,
	type KeyPair,
} from "@achoo254/chat-remote-protocol";
import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import { openExchange, type SocketFactory } from "./socket.ts";

export interface PairTarget {
	readonly url: string;
	readonly device: KeyPair;
	readonly deviceName: string;
	readonly socket: SocketFactory;
}

/** Runs the handshake once with the install secret and returns the machine key to pin. */
export async function confirmTrust(target: PairTarget, trust: DeviceTrust): Promise<Uint8Array> {
	const exchange = await openExchange(target.socket, target.url);
	try {
		const handshake = await startHandshake({ device: target.device, deviceName: target.deviceName, trust });
		exchange.send(new Uint8Array(handshake.hello));
		const { machineKey } = await handshake.finish(await exchange.next());
		return machineKey;
	} finally {
		exchange.close();
	}
}

/**
 * Pairs with the 6-digit code the user's Authenticator app shows for the
 * machine; returns the machine key to pin. A wrong code throws PakeFailure
 * (the machine sends no error for it); a locked machine or one without
 * Authenticator pairing throws HandshakeFailure (TOO_MANY_ATTEMPTS, TOTP_NOT_SET).
 */
export async function pairWithCode(target: PairTarget, code: string): Promise<Uint8Array> {
	if (!/^[0-9]{6}$/.test(code)) throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
	const exchange = await openExchange(target.socket, target.url);
	try {
		const pake = await pakeStart({ code, deviceKey: target.device.publicKey, deviceName: target.deviceName });
		exchange.send(new Uint8Array(encodePlain({ case: "pakeStart", value: pake.start })));
		const reply = decodePlain(await exchange.next());
		if (reply.body.case === "error") throw new HandshakeFailure(reply.body.value.code);
		if (reply.body.case !== "pakeReply") throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
		const { machineKey, finish } = await pake.finish(reply.body.value);
		exchange.send(new Uint8Array(encodePlain({ case: "pakeFinish", value: finish })));
		// The machine adds this device, then closes; the link reconnects with a normal handshake.
		await exchange.next().catch(() => undefined);
		return machineKey;
	} finally {
		exchange.close();
	}
}
