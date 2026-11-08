// Pairing a new device with a machine.
//
// - One-command install: the browser makes a 32-byte secret and gives it to
//   `chat-agent install` on stdin; B proves it in the handshake (see
//   handshake.ts). Nothing secret goes through the chat server.
// - `chat-agent pair` opens a PairingWindow for 10 minutes and prints a QR
//   (B's key + a 32-byte secret) and a 6-digit code. The QR path is proven
//   in the handshake; the code path runs CPace (a balanced PAKE on
//   ristretto255) first, so a relay that watches the exchange cannot test
//   codes offline, and each wrong guess costs one of 5 attempts.
import { create } from "@bufbuild/protobuf";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import {
  HandshakeErrorCode,
  type PakeFinish,
  PakeFinishSchema,
  type PakeReply,
  PakeReplySchema,
  type PakeStart,
  PakeStartSchema,
} from "@achoo254/chat-proto/remote/remote";
import { equal, fromBase64Url, lv, random, toBase64Url, utf8 } from "../bytes.ts";
import { hmac, sha256 } from "./primitives.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;

/** B's state while `chat-agent pair` runs. */
export class PairingWindow {
  private attempts = 0;
  private used = false;

  constructor(
    readonly code: string,
    readonly secret: Uint8Array<ArrayBuffer>,
    readonly expiresAt: number,
  ) {}

  static open(now = Date.now()): PairingWindow {
    return new PairingWindow(sixDigits(), random(32), now + PAIRING_TTL_MS);
  }

  /** Null while the window still accepts an attempt. */
  check(now: number): HandshakeErrorCode | null {
    if (this.used || now >= this.expiresAt) return HandshakeErrorCode.PAIRING_EXPIRED;
    if (this.attempts >= PAIRING_MAX_ATTEMPTS) return HandshakeErrorCode.TOO_MANY_ATTEMPTS;
    return null;
  }

  fail(): void {
    this.attempts += 1;
  }

  /** One successful pairing closes the window. */
  consume(): void {
    this.used = true;
  }
}

function sixDigits(): string {
  // Rejection sampling keeps every code equally likely.
  for (;;) {
    const n = new DataView(random(4).buffer).getUint32(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
  }
}

/** What the QR shows: machine key and secret, base64url, dot-separated. */
export function encodeQr(machineKey: Uint8Array, secret: Uint8Array): string {
  return `hrp1.${toBase64Url(machineKey)}.${toBase64Url(secret)}`;
}

export function decodeQr(text: string): { machineKey: Uint8Array<ArrayBuffer>; secret: Uint8Array<ArrayBuffer> } {
  const [tag, key, secret] = text.trim().split(".");
  if (tag !== "hrp1" || !key || !secret) throw new Error("not a pairing code");
  const out = { machineKey: fromBase64Url(key), secret: fromBase64Url(secret) };
  if (out.machineKey.length !== 32 || out.secret.length !== 32) throw new Error("not a pairing code");
  return out;
}

// ---------------------------------------------------------------------------
// CPace on ristretto255 (draft-irtf-cfrg-cpace), with explicit key
// confirmation tags that also bind both static keys.

const DSI = utf8("CPaceRistretto255");
const Point = ristretto255.Point;
type RPoint = InstanceType<typeof Point>;

function generator(code: string, sid: Uint8Array): RPoint {
  const msg = lv(DSI, utf8(code), utf8("hoandat-remote-pair"), sid);
  return ristretto255_hasher.hashToCurve(msg, { DST: "CPaceRistretto255_G" }) as RPoint;
}

function randomScalar(): bigint {
  for (;;) {
    const s = ristretto255_hasher.hashToScalar(random(64));
    if (s !== 0n) return s;
  }
}

function decodePoint(bytes: Uint8Array): RPoint {
  if (bytes.length !== 32) throw new PakeFailure();
  let p: RPoint;
  try {
    p = Point.fromBytes(bytes);
  } catch {
    throw new PakeFailure();
  }
  if (p.is0()) throw new PakeFailure();
  return p;
}

export class PakeFailure extends Error {
  constructor() {
    super("pairing code did not match");
  }
}

async function sessionKey(sid: Uint8Array, k: RPoint, ya: Uint8Array, yb: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (k.is0()) throw new PakeFailure();
  return sha256(lv(utf8("CPaceRistretto255_ISK"), sid, k.toBytes(), ya, yb));
}

function pakeTranscript(start: PakeStart, reply: Pick<PakeReply, "share" | "staticKey">) {
  return sha256(lv(start.sid, start.share, start.staticKey, utf8(start.deviceName), reply.share, reply.staticKey));
}

/** Device side (A): the user typed the code shown on B. */
export async function pakeStart(opts: { code: string; deviceKey: Uint8Array; deviceName: string }) {
  const sid = random(16);
  const g = generator(opts.code, sid);
  const y = randomScalar();
  const start = create(PakeStartSchema, {
    share: g.multiply(y).toBytes(),
    staticKey: opts.deviceKey,
    deviceName: opts.deviceName.slice(0, 64),
    sid,
  });
  return {
    start,
    /** Checks B's tag; returns B's key to pin and the finish message. */
    async finish(reply: PakeReply): Promise<{ machineKey: Uint8Array; finish: PakeFinish }> {
      const isk = await sessionKey(sid, decodePoint(reply.share).multiply(y), start.share, reply.share);
      const t = await pakeTranscript(start, reply);
      if (!equal(await hmac(isk, utf8("B"), t), reply.tag)) throw new PakeFailure();
      if (reply.staticKey.length !== 32) throw new PakeFailure();
      return {
        machineKey: reply.staticKey,
        finish: create(PakeFinishSchema, { tag: await hmac(isk, utf8("A"), t) }),
      };
    },
  };
}

/** Machine side (B): answer a PakeStart while the window is open. */
export async function pakeReply(opts: { window: PairingWindow; machineKey: Uint8Array; start: PakeStart; now?: number }) {
  const closed = opts.window.check(opts.now ?? Date.now());
  if (closed) return { ok: false as const, code: closed };
  const { start } = opts;
  if (start.sid.length !== 16 || start.staticKey.length !== 32) {
    return { ok: false as const, code: HandshakeErrorCode.MALFORMED };
  }
  // Counted now: an attacker who never sends PakeFinish still spends a try.
  opts.window.fail();
  const g = generator(opts.window.code, start.sid);
  const y = randomScalar();
  let isk: Uint8Array<ArrayBuffer>;
  const share = g.multiply(y).toBytes();
  try {
    isk = await sessionKey(start.sid, decodePoint(start.share).multiply(y), start.share, share);
  } catch {
    return { ok: false as const, code: HandshakeErrorCode.MALFORMED };
  }
  const t = await pakeTranscript(start, { share, staticKey: opts.machineKey });
  const reply = create(PakeReplySchema, { share, staticKey: opts.machineKey, tag: await hmac(isk, utf8("B"), t) });
  const window = opts.window;
  return {
    ok: true as const,
    reply,
    /** Verifies A's tag; on success the device key can be added to the paired list. */
    async confirm(finish: PakeFinish): Promise<{ deviceKey: Uint8Array; deviceName: string } | null> {
      if (!equal(await hmac(isk, utf8("A"), t), finish.tag)) return null;
      window.consume();
      return { deviceKey: start.staticKey, deviceName: start.deviceName };
    },
  };
}

