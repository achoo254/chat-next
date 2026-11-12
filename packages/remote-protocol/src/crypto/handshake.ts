// Mutually authenticated key agreement between a device (A) and a machine (B)
// over an untrusted relay, Noise-KK style: three X25519 results (ee, es, se)
// feed HKDF-SHA256, so both static keys are proven and a later key leak does
// not open recorded sessions. B confirms the keys in its Ready; A's first
// sealed frame confirms A's.
//
// Both static keys come from the owner's chat account: A expects the machine
// key the chat lists for the machine (Machine.public_key) and B accepts the
// device keys the chat lists for its owner (HeartbeatResponse.trusted_devices).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  HandshakeErrorCode,
  type Hello,
  HelloSchema,
  type Plain,
  PlainSchema,
  type Ready,
  ReadySchema,
} from "@achoo254/chat-proto/remote/remote";
import { concat, equal, lv, random, u32, utf8 } from "../bytes.ts";
import { type SessionKeys, Session, openBytes, sealBytes } from "./framing.ts";
import { type KeyPair, dh, generateKeyPair, hkdf, sha256 } from "./primitives.ts";

export const PROTOCOL_VERSION = 3;
export const MIN_PROTOCOL_VERSION = 3;

const LABEL = "hoandat-remote-v1";
const KEY_LENGTH = 32;

export class HandshakeFailure extends Error {
  constructor(
    readonly code: HandshakeErrorCode,
    /** The peer's supported range, when it sent one. */
    readonly peer?: { protocolVersion: number; minProtocolVersion: number },
  ) {
    super(`handshake failed: ${HandshakeErrorCode[code] ?? code}`);
  }
}

export function encodePlain(body: Plain["body"]): Uint8Array {
  return toBinary(PlainSchema, create(PlainSchema, { body }));
}

export function decodePlain(bytes: Uint8Array): Plain {
  try {
    return fromBinary(PlainSchema, bytes);
  } catch {
    throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
  }
}

/** A HandshakeError carrying this side's supported versions. */
export function encodeHandshakeError(code: HandshakeErrorCode): Uint8Array {
  return encodePlain({
    case: "error",
    value: { $typeName: "remote.v1.HandshakeError", code, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION },
  });
}

function versionsCompatible(peer: { protocolVersion: number; minProtocolVersion: number }): boolean {
  return peer.protocolVersion >= MIN_PROTOCOL_VERSION && PROTOCOL_VERSION >= peer.minProtocolVersion;
}

async function transcript(h: Hello, r: Omit<Ready, "confirm">): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(
    lv(utf8(LABEL)),
    u32(h.protocolVersion),
    u32(h.minProtocolVersion),
    lv(h.ephemeralKey, h.staticKey, h.nonce),
    u32(r.protocolVersion),
    u32(r.minProtocolVersion),
    lv(r.ephemeralKey, r.staticKey, r.nonce),
  );
}

async function deriveKeys(ee: Uint8Array, es: Uint8Array, se: Uint8Array, h: Hello, r: Ready, t: Uint8Array<ArrayBuffer>) {
  const okm = await hkdf(concat(ee, es, se), await sha256(h.nonce, r.nonce), t, 32 + 32 + 15);
  const keys: SessionKeys = { aToB: okm.slice(0, 32), bToA: okm.slice(32, 64), sessionId: okm.slice(64) };
  return keys;
}

// ---------------------------------------------------------------------------
// Device side (A)

export type DeviceHandshake = {
  /** Send this first. */
  hello: Uint8Array;
  /** Feed B's answer; resolves with the open session. */
  finish(reply: Uint8Array): Promise<{ session: Session }>;
};

/**
 * Opens a session to the machine whose key the chat lists as
 * expectedMachineKey. A Ready with another static key fails with
 * MACHINE_KEY_CHANGED before any key is derived; a Ready whose key
 * confirmation does not check fails with BAD_PROOF.
 */
export async function startHandshake(opts: { device: KeyPair; expectedMachineKey: Uint8Array }): Promise<DeviceHandshake> {
  if (opts.expectedMachineKey.length !== KEY_LENGTH) throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
  const eph = await generateKeyPair();
  const hello = create(HelloSchema, {
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    ephemeralKey: eph.publicKey,
    staticKey: opts.device.publicKey,
    nonce: random(32),
  });

  return {
    hello: encodePlain({ case: "hello", value: hello }),
    async finish(reply) {
      const plain = decodePlain(reply);
      if (plain.body.case === "error") {
        const e = plain.body.value;
        throw new HandshakeFailure(e.code, { protocolVersion: e.protocolVersion, minProtocolVersion: e.minProtocolVersion });
      }
      if (plain.body.case !== "ready") throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
      const ready = plain.body.value;
      if (!versionsCompatible(ready)) {
        throw new HandshakeFailure(HandshakeErrorCode.VERSION_UNSUPPORTED, ready);
      }
      if (ready.ephemeralKey.length !== KEY_LENGTH || ready.nonce.length !== 32) {
        throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
      }
      const machineKey = ready.staticKey;
      if (!equal(opts.expectedMachineKey, machineKey)) throw new HandshakeFailure(HandshakeErrorCode.MACHINE_KEY_CHANGED);

      let ee: Uint8Array, es: Uint8Array, se: Uint8Array;
      try {
        ee = await dh(eph.privateKey, ready.ephemeralKey);
        es = await dh(eph.privateKey, machineKey);
        se = await dh(opts.device.privateKey, ready.ephemeralKey);
      } catch {
        throw new HandshakeFailure(HandshakeErrorCode.MALFORMED);
      }
      const t = await transcript(hello, ready);
      const keys = await deriveKeys(ee, es, se, hello, ready, t);
      let confirmed: Uint8Array;
      try {
        confirmed = openBytes(keys, "b-to-a", 0n, ready.confirm);
      } catch {
        throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      }
      if (!equal(confirmed, t)) throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      return { session: new Session(keys, "a", machineKey) };
    },
  };
}

// ---------------------------------------------------------------------------
// Machine side (B)

/**
 * What the machine knows of a device key from the owner's account: trusted
 * (listed now), revoked (listed before and dropped since) or unknown (never
 * listed: another account, or a key the machine has not learnt yet).
 */
export type DeviceStatus = "trusted" | "revoked" | "unknown";

export type MachineAuth = {
  machine: KeyPair;
  deviceStatus(deviceKey: Uint8Array): DeviceStatus;
};

export type Accepted = {
  ok: true;
  reply: Uint8Array;
  session: Session;
  deviceKey: Uint8Array;
};

export type Rejected = { ok: false; reply: Uint8Array; code: HandshakeErrorCode };

export async function acceptHello(bytes: Uint8Array, auth: MachineAuth): Promise<Accepted | Rejected> {
  const reject = (code: HandshakeErrorCode): Rejected => ({ ok: false, reply: encodeHandshakeError(code), code });
  let plain: Plain;
  try {
    plain = decodePlain(bytes);
  } catch {
    return reject(HandshakeErrorCode.MALFORMED);
  }
  if (plain.body.case !== "hello") return reject(HandshakeErrorCode.MALFORMED);
  const hello = plain.body.value;
  if (!versionsCompatible(hello)) return reject(HandshakeErrorCode.VERSION_UNSUPPORTED);
  if (hello.ephemeralKey.length !== KEY_LENGTH || hello.staticKey.length !== KEY_LENGTH || hello.nonce.length !== 32) {
    return reject(HandshakeErrorCode.MALFORMED);
  }

  const deviceKey = hello.staticKey;
  const status = auth.deviceStatus(deviceKey);
  if (status === "revoked") return reject(HandshakeErrorCode.REVOKED);
  if (status !== "trusted") return reject(HandshakeErrorCode.UNKNOWN_DEVICE);

  const eph = await generateKeyPair();
  const ready = create(ReadySchema, {
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    ephemeralKey: eph.publicKey,
    staticKey: auth.machine.publicKey,
    nonce: random(32),
  });
  let ee: Uint8Array, es: Uint8Array, se: Uint8Array;
  try {
    ee = await dh(eph.privateKey, hello.ephemeralKey);
    es = await dh(auth.machine.privateKey, hello.ephemeralKey);
    se = await dh(eph.privateKey, hello.staticKey);
  } catch {
    return reject(HandshakeErrorCode.MALFORMED);
  }
  const t = await transcript(hello, ready);
  const keys = await deriveKeys(ee, es, se, hello, ready, t);
  ready.confirm = sealBytes(keys, "b-to-a", 0n, t);
  return {
    ok: true,
    reply: encodePlain({ case: "ready", value: ready }),
    session: new Session(keys, "b", deviceKey),
    deviceKey,
  };
}
