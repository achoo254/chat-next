// Mutually authenticated key agreement between a device (A) and a machine (B)
// over an untrusted relay, Noise-KK style: three X25519 results (ee, es, se)
// feed HKDF-SHA256, so both static keys are proven and a later key leak does
// not open recorded sessions. B confirms the keys in its Ready; A's first
// sealed frame confirms A's.
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
import type { PairingWindow } from "./pairing.ts";
import { type KeyPair, dh, generateKeyPair, hkdf, hmac, sha256 } from "./primitives.ts";

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

const LABEL = "hoandat-remote-v1";
const MAX_DEVICE_NAME = 64;

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

function errorPlain(code: HandshakeErrorCode): Uint8Array {
  return encodePlain({
    case: "error",
    value: { $typeName: "remote.v1.HandshakeError", code, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION },
  });
}

function versionsCompatible(peer: { protocolVersion: number; minProtocolVersion: number }): boolean {
  return peer.protocolVersion >= MIN_PROTOCOL_VERSION && PROTOCOL_VERSION >= peer.minProtocolVersion;
}

export function installProof(secret: Uint8Array<ArrayBuffer>, deviceKey: Uint8Array, machineKey: Uint8Array) {
  return hmac(secret, utf8("install"), deviceKey, machineKey);
}

export function qrProof(secret: Uint8Array<ArrayBuffer>, deviceKey: Uint8Array, machineKey: Uint8Array) {
  return hmac(secret, utf8("qr"), deviceKey, machineKey);
}

async function transcript(h: Hello, r: Omit<Ready, "confirm">): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(
    lv(utf8(LABEL)),
    u32(h.protocolVersion),
    u32(h.minProtocolVersion),
    lv(h.ephemeralKey, h.staticKey, h.nonce, h.pairProof, utf8(h.deviceName)),
    u32(r.protocolVersion),
    u32(r.minProtocolVersion),
    lv(r.ephemeralKey, r.staticKey, r.nonce, r.installProof),
  );
}

async function deriveKeys(ee: Uint8Array, es: Uint8Array, se: Uint8Array, h: Hello, r: Ready, t: Uint8Array<ArrayBuffer>) {
  const okm = await hkdf(concat(ee, es, se), await sha256(h.nonce, r.nonce), t, 32 + 32 + 15);
  const keys: SessionKeys = { aToB: okm.slice(0, 32), bToA: okm.slice(32, 64), sessionId: okm.slice(64) };
  return keys;
}

// ---------------------------------------------------------------------------
// Device side (A)

export type DeviceTrust =
  /** B's machine key pinned at pairing. */
  | { kind: "pinned"; machineKey: Uint8Array }
  /** First connection after the one-command install: B proves the secret. */
  | { kind: "install"; secret: Uint8Array<ArrayBuffer> }
  /** QR pairing: the QR carried B's key and a secret A proves. */
  | { kind: "qr"; machineKey: Uint8Array<ArrayBuffer>; secret: Uint8Array<ArrayBuffer> };

export type DeviceHandshake = {
  /** Send this first. */
  hello: Uint8Array;
  /** Feed B's answer; resolves with the open session and B's key to pin. */
  finish(reply: Uint8Array): Promise<{ session: Session; machineKey: Uint8Array }>;
};

export async function startHandshake(opts: {
  device: KeyPair;
  deviceName: string;
  trust: DeviceTrust;
}): Promise<DeviceHandshake> {
  const eph = await generateKeyPair();
  const pairProof =
    opts.trust.kind === "qr"
      ? await qrProof(opts.trust.secret, opts.device.publicKey, opts.trust.machineKey)
      : new Uint8Array();
  const hello = create(HelloSchema, {
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    ephemeralKey: eph.publicKey,
    staticKey: opts.device.publicKey,
    nonce: random(32),
    pairProof,
    deviceName: opts.deviceName.slice(0, MAX_DEVICE_NAME),
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
      const machineKey = ready.staticKey;
      const trust = opts.trust;
      if (trust.kind === "install") {
        const want = await installProof(trust.secret, opts.device.publicKey, machineKey);
        if (!equal(want, ready.installProof)) throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      } else if (!equal(trust.machineKey, machineKey)) {
        throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      }

      const ee = await dh(eph.privateKey, ready.ephemeralKey);
      const es = await dh(eph.privateKey, machineKey);
      const se = await dh(opts.device.privateKey, ready.ephemeralKey);
      const t = await transcript(hello, ready);
      const keys = await deriveKeys(ee, es, se, hello, ready, t);
      let confirmed: Uint8Array;
      try {
        confirmed = openBytes(keys, "b-to-a", 0n, ready.confirm);
      } catch {
        throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      }
      if (!equal(confirmed, t)) throw new HandshakeFailure(HandshakeErrorCode.BAD_PROOF);
      return { session: new Session(keys, "a", machineKey), machineKey };
    },
  };
}

// ---------------------------------------------------------------------------
// Machine side (B)

export type DeviceStatus = "paired" | "revoked" | "unknown";

export type MachineAuth = {
  machine: KeyPair;
  deviceStatus(deviceKey: Uint8Array): DeviceStatus;
  /** Set from `chat-agent install --trust`: the installing browser's key and secret. */
  install?: { deviceKey: Uint8Array; secret: Uint8Array<ArrayBuffer> } | undefined;
  /** Open while `chat-agent pair` runs. */
  pairing?: PairingWindow | undefined;
  now?: () => number;
};

export type Accepted = {
  ok: true;
  reply: Uint8Array;
  session: Session;
  deviceKey: Uint8Array;
  deviceName: string;
  /** Set when this handshake paired a new device. */
  pairedBy?: "install" | "qr";
};

export type Rejected = { ok: false; reply: Uint8Array; code: HandshakeErrorCode };

export async function acceptHello(bytes: Uint8Array, auth: MachineAuth): Promise<Accepted | Rejected> {
  const reject = (code: HandshakeErrorCode): Rejected => ({ ok: false, reply: errorPlain(code), code });
  let plain: Plain;
  try {
    plain = decodePlain(bytes);
  } catch {
    return reject(HandshakeErrorCode.MALFORMED);
  }
  if (plain.body.case !== "hello") return reject(HandshakeErrorCode.MALFORMED);
  const hello = plain.body.value;
  if (!versionsCompatible(hello)) return reject(HandshakeErrorCode.VERSION_UNSUPPORTED);
  if (hello.ephemeralKey.length !== 32 || hello.staticKey.length !== 32 || hello.nonce.length !== 32) {
    return reject(HandshakeErrorCode.MALFORMED);
  }

  const deviceKey = hello.staticKey;
  const machineKey = auth.machine.publicKey;
  let pairedBy: Accepted["pairedBy"];
  let proof = new Uint8Array();
  const status = auth.deviceStatus(deviceKey);
  if (status === "revoked") return reject(HandshakeErrorCode.REVOKED);
  if (auth.install && equal(auth.install.deviceKey, deviceKey)) {
    proof = await installProof(auth.install.secret, deviceKey, machineKey);
    if (status === "unknown") pairedBy = "install";
  } else if (status === "unknown") {
    if (hello.pairProof.length === 0 || !auth.pairing) return reject(HandshakeErrorCode.UNKNOWN_DEVICE);
    const closed = auth.pairing.check(auth.now?.() ?? Date.now());
    if (closed) return reject(closed);
    const want = await qrProof(auth.pairing.secret, deviceKey, machineKey);
    if (!equal(want, hello.pairProof)) {
      auth.pairing.fail();
      return reject(HandshakeErrorCode.BAD_PROOF);
    }
    auth.pairing.consume();
    pairedBy = "qr";
  }

  const eph = await generateKeyPair();
  const ready = create(ReadySchema, {
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    ephemeralKey: eph.publicKey,
    staticKey: machineKey,
    nonce: random(32),
    installProof: proof,
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
  const result: Accepted = {
    ok: true,
    reply: encodePlain({ case: "ready", value: ready }),
    session: new Session(keys, "b", deviceKey),
    deviceKey,
    deviceName: hello.deviceName.slice(0, MAX_DEVICE_NAME),
  };
  if (pairedBy) result.pairedBy = pairedBy;
  return result;
}
