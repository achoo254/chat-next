// A machine for the account key tests: a FakeMachine (real handshake and
// sealed frames) that keeps one Advisor key with its source, as tunelo 3.22.0+
// does, and runs the machine-to-machine hand-off with real X25519 sealing, so
// a test sees exactly what the page relays. An older tunelo (share: false)
// knows none of the account key requests.
import { toBinary } from "@bufbuild/protobuf";
import { AdvisorKeySource, ErrorCode, ErrorReason, FrameSchema, LoginState, type Frame } from "@achoo254/chat-proto/remote/remote";
import { concat, dh, generateKeyPair, hkdf, open, random, seal, utf8, type KeyPair } from "@achoo254/chat-remote-protocol";
import { defaultAnswer, FakeMachine, type Body, type FakeSocket } from "../machines/fake-machine.ts";

const INFO = utf8("fake advisor key share");

export type HeldKey = { value: string; source: "own" | "account"; setAt: number; setBy: string };

/** A stand-in fingerprint: the key's last 6 characters (the real one is a SHA-256 prefix). */
export function fingerprintOf(key: string): string {
	return key.slice(-6);
}

async function boxKey(privateKey: CryptoKey, peer: Uint8Array, sender: Uint8Array, recipient: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return hkdf(await dh(privateKey, peer), concat(sender, recipient), INFO, 32);
}

export class KeyMachine {
	key: HeldKey | null = null;
	/** Takes the account's key (tunelo 3.22.0+). */
	share = true;
	private readonly tickets = new Map<string, KeyPair>();

	private constructor(
		readonly machine: FakeMachine,
		readonly name: string,
		readonly url: string,
	) {}

	static async create(name: string, url: string, device: Uint8Array): Promise<KeyMachine> {
		const machine = await FakeMachine.create();
		machine.trusted = [device];
		const m = new KeyMachine(machine, name, url);
		machine.handler = (frame, socket) => m.answer(frame, socket);
		return m;
	}

	/** Every frame the page sent this machine, as bytes. */
	receivedBytes(): Uint8Array {
		return concat(...this.machine.received.map((f) => toBinary(FrameSchema, f)));
	}

	private info(): Body {
		const k = this.key;
		const keySource = k === null || !this.share ? AdvisorKeySource.UNSPECIFIED : k.source === "account" ? AdvisorKeySource.ACCOUNT : AdvisorKeySource.OWN;
		return {
			case: "machineInfo",
			value: {
				name: this.name,
				os: "darwin",
				agentVersion: this.share ? "3.22.0" : "3.13.0",
				providers: [{ id: "claude", name: "Claude Code", loginState: LoginState.OK, capabilities: { sessionMcp: true, advisorSession: true } }],
				advisor: {
					available: true,
					keySet: k !== null,
					keyFingerprint: k === null ? "" : fingerprintOf(k.value),
					setByDevice: k?.setBy ?? "",
					setAt: BigInt(k?.setAt ?? 0),
					...(this.share ? { keySource, keyShare: true } : {}),
				},
			},
		};
	}

	/** The key changed: the page hears the machine's info, as every device does. */
	private changed(socket: FakeSocket): void {
		setTimeout(() => this.machine.send(socket, this.info()), 0);
	}

	private refusal(reason: ErrorReason): Body {
		return { case: "error", value: { code: ErrorCode.INVALID, message: "refused", reason, subject: "" } };
	}

	private refuse(reason: ErrorReason): Body[] {
		return [this.refusal(reason)];
	}

	private answer(frame: Frame, socket: FakeSocket): Body[] | undefined {
		const b = frame.body;
		const ack: Body[] = [{ case: "ack", value: {} }];
		switch (b.case) {
			case "machineInfoRequest":
				return [this.info()];
			case "advisorSetKey": {
				const account = this.share && b.value.source === AdvisorKeySource.ACCOUNT;
				if (account && this.key?.source === "own") return this.refuse(ErrorReason.ADVISOR_OWN_KEY);
				this.key = { value: b.value.key, source: account ? "account" : "own", setAt: account && b.value.setAt > 0n ? Number(b.value.setAt) : Date.now(), setBy: "Chrome" };
				this.changed(socket);
				return ack;
			}
			case "advisorRemoveKey": {
				const only = b.value.source === AdvisorKeySource.ACCOUNT ? "account" : b.value.source === AdvisorKeySource.OWN ? "own" : undefined;
				if (this.key !== null && (only === undefined || !this.share || this.key.source === only)) this.key = null;
				this.changed(socket);
				return ack;
			}
			default:
				if (!this.share) return defaultAnswer(frame);
				return this.shareAnswer(frame, socket);
		}
	}

	private shareAnswer(frame: Frame, socket: FakeSocket): Body[] | undefined {
		const b = frame.body;
		switch (b.case) {
			case "advisorKeyPromote":
				if (this.key?.source !== "own") return this.refuse(ErrorReason.ADVISOR_NO_KEY);
				this.key = { ...this.key, source: "account", setAt: Number(b.value.setAt) };
				this.changed(socket);
				return [{ case: "ack", value: {} }];
			case "advisorKeyShareBegin":
				void generateKeyPair().then((pair) => {
					const ticketId = `t${this.tickets.size + 1}-${this.name}`;
					this.tickets.set(ticketId, pair);
					this.machine.send(socket, { case: "advisorKeyShareTicket", value: { ticketId, publicKey: pair.publicKey } }, frame.id);
				});
				return [];
			case "advisorKeySeal": {
				const held = this.key;
				if (held?.source !== "account") return this.refuse(ErrorReason.ADVISOR_NO_KEY);
				void this.sealFor(b.value.recipientPublicKey, held).then((sealed) =>
					this.machine.send(socket, { case: "advisorKeySealed", value: { sealed, fingerprint: fingerprintOf(held.value) } }, frame.id),
				);
				return [];
			}
			case "advisorKeyShareOpen": {
				const pair = this.tickets.get(b.value.ticketId);
				this.tickets.delete(b.value.ticketId);
				if (pair === undefined) return this.refuse(ErrorReason.ADVISOR_KEY_SHARE_FAILED);
				if (this.key?.source === "own") return this.refuse(ErrorReason.ADVISOR_OWN_KEY);
				void this.openWith(pair, b.value.sealed).then((opened) => {
					if (opened === null) return this.machine.send(socket, this.refusal(ErrorReason.ADVISOR_KEY_SHARE_FAILED), frame.id);
					this.key = { ...opened, source: "account" };
					this.machine.send(socket, { case: "ack", value: {} }, frame.id);
					this.changed(socket);
				});
				return [];
			}
			default:
				return defaultAnswer(frame);
		}
	}

	private async sealFor(recipient: Uint8Array, held: HeldKey): Promise<Uint8Array> {
		const eph = await generateKeyPair();
		const nonce = random(24);
		// Encoded through Buffer: jsdom's TextEncoder gives bytes of another realm, which tweetnacl refuses.
		const payload = Uint8Array.from(Buffer.from(JSON.stringify({ value: held.value, setAt: held.setAt, setBy: held.setBy }), "utf8"));
		const box = seal(await boxKey(eph.privateKey, recipient, eph.publicKey, recipient), nonce, payload);
		return concat(eph.publicKey, nonce, box);
	}

	private async openWith(pair: KeyPair, sealed: Uint8Array): Promise<Omit<HeldKey, "source"> | null> {
		const sender = sealed.slice(0, 32);
		const plain = open(await boxKey(pair.privateKey, sender, sender, pair.publicKey), Uint8Array.from(sealed.slice(32, 56)), Uint8Array.from(sealed.slice(56)));
		if (plain === null) return null;
		return JSON.parse(new TextDecoder().decode(plain)) as Omit<HeldKey, "source">;
	}
}

/** Whether `haystack` holds `needle` anywhere. */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}
