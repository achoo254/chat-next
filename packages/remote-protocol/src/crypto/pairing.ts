// Pairing a new device (A) with a machine (B) by the machine's authenticator
// code. B keeps a TOTP secret (totp.ts) that a paired device set; the user
// reads the current 6-digit code from their authenticator app and types it on
// the new device. Nothing secret goes through the chat server.
//
// The code is the password of CPace (a balanced PAKE on ristretto255), so a
// relay that watches or tampers with the exchange cannot test codes offline:
// each guess needs a live PakeStart. B cannot tell which 30-second step the
// device's code came from, so its PakeReply holds one CPace candidate per
// accepted step (previous, current, next), each with its own share and tag;
// A keeps the one whose tag checks and B, on PakeFinish, tries every
// candidate. Wrong codes fail the same way whatever the step.
//
// Every PakeStart counts as an attempt before any work is done; 5 attempts
// that did not pair lock pairing for 15 minutes, and a successful pairing
// clears the count. Once paired, the device reconnects with a normal Hello.
//
// The one-command install (`tunelo install --trust`) is not pairing by code:
// B proves the install secret in the handshake instead (handshake.ts).
import { create } from "@bufbuild/protobuf";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import {
  HandshakeErrorCode,
  type PakeCandidate,
  PakeCandidateSchema,
  type PakeFinish,
  PakeFinishSchema,
  type PakeReply,
  PakeReplySchema,
  type PakeStart,
  PakeStartSchema,
} from "@achoo254/chat-proto/remote/remote";
import { equal, lv, random, utf8 } from "../bytes.ts";
import { hmac, sha256 } from "./primitives.ts";
import { isTotpSecret, normalizeTotpCode, totpCandidates } from "./totp.ts";

export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_LOCKOUT_MS = 15 * 60 * 1000;
export const PAIRING_LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000;

/** How pairing a new device was proven, for the audit log. */
export type PairingMethod = "install" | "totp";

/**
 * B's long-lived pairing state: the authenticator secret, if one is set, and
 * the shared count of attempts that did not pair. Kept in memory; the agent
 * stores the secret itself.
 */
export class TotpPairing {
  private secretBytes: Uint8Array<ArrayBuffer> | undefined;
  private attempts = 0;
  private lockouts = 0;
  private lockedUntilMs = 0;

  constructor(secret?: Uint8Array) {
    if (secret) this.setSecret(secret);
  }

  get enabled(): boolean {
    return this.secretBytes !== undefined;
  }

  /** Unix milliseconds until which pairing is locked; 0 when not locked. */
  get lockedUntil(): number {
    return this.lockedUntilMs;
  }

  /** Sets or replaces the secret; a new secret also clears the attempt count. */
  setSecret(secret: Uint8Array): void {
    if (!isTotpSecret(secret)) throw new Error("a TOTP secret is 20 bytes");
    this.secretBytes = new Uint8Array(secret);
    this.succeed();
  }

  /** Null while pairing accepts an attempt; otherwise why it does not. */
  check(now: number): HandshakeErrorCode | null {
    if (!this.secretBytes) return HandshakeErrorCode.TOTP_NOT_SET;
    if (now < this.lockedUntilMs) return HandshakeErrorCode.TOO_MANY_ATTEMPTS;
    return null;
  }

  /**
   * Counts one attempt; the fifth locks pairing. The first lock lasts
   * PAIRING_LOCKOUT_MS and each lock in a row doubles it, up to
   * PAIRING_LOCKOUT_MAX_MS, so guessing for months stays out of reach.
   */
  fail(now: number): void {
    this.attempts += 1;
    if (this.attempts >= PAIRING_MAX_ATTEMPTS) {
      this.attempts = 0;
      const lockMs = Math.min(PAIRING_LOCKOUT_MS * 2 ** this.lockouts, PAIRING_LOCKOUT_MAX_MS);
      this.lockouts += 1;
      this.lockedUntilMs = now + lockMs;
    }
  }

  /** A device paired or the secret changed: counts and any lock are cleared. */
  succeed(): void {
    this.attempts = 0;
    this.lockouts = 0;
    this.lockedUntilMs = 0;
  }

  /** The codes accepted at `now`; empty without a secret. */
  codes(now: number): string[] {
    return this.secretBytes ? totpCandidates(this.secretBytes, now) : [];
  }
}

// ---------------------------------------------------------------------------
// CPace on ristretto255 (draft-irtf-cfrg-cpace), with explicit key
// confirmation tags that also bind both static keys.

const DSI = utf8("CPaceRistretto255");
const Point = ristretto255.Point;
type RPoint = InstanceType<typeof Point>;

function generator(code: string, sid: Uint8Array): RPoint {
  const msg = lv(DSI, utf8(code), utf8("hoandat-remote-pair-totp"), sid);
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

function pakeTranscript(start: PakeStart, share: Uint8Array, staticKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(lv(start.sid, start.share, start.staticKey, utf8(start.deviceName), share, staticKey));
}

export type DevicePake = {
  /** Send as Plain.pakeStart. */
  start: PakeStart;
  /**
   * Checks B's candidates; returns B's key to pin and the PakeFinish to send.
   * Throws PakeFailure when no candidate matches the code (a wrong code).
   */
  finish(reply: PakeReply): Promise<{ machineKey: Uint8Array; finish: PakeFinish }>;
};

/** Device side (A): the user typed the machine's authenticator code. */
export async function pakeStart(opts: { code: string; deviceKey: Uint8Array; deviceName: string }): Promise<DevicePake> {
  const code = normalizeTotpCode(opts.code);
  if (code === null) throw new Error("the pairing code is 6 digits");
  if (opts.deviceKey.length !== 32) throw new Error("bad device key");
  const sid = random(16);
  const y = randomScalar();
  const start = create(PakeStartSchema, {
    share: generator(code, sid).multiply(y).toBytes(),
    staticKey: opts.deviceKey,
    deviceName: opts.deviceName.slice(0, 64),
    sid,
  });
  return {
    start,
    async finish(reply) {
      if (reply.staticKey.length !== 32) throw new PakeFailure();
      for (const c of reply.candidates) {
        let isk: Uint8Array<ArrayBuffer>;
        try {
          isk = await sessionKey(sid, decodePoint(c.share).multiply(y), start.share, c.share);
        } catch {
          continue;
        }
        const t = await pakeTranscript(start, c.share, reply.staticKey);
        if (!equal(await hmac(isk, utf8("B"), t), c.tag)) continue;
        return {
          machineKey: reply.staticKey,
          finish: create(PakeFinishSchema, { tag: await hmac(isk, utf8("A"), t) }),
        };
      }
      throw new PakeFailure();
    },
  };
}

export type MachinePake =
  | { ok: false; code: HandshakeErrorCode }
  | {
      ok: true;
      /** Send as Plain.pakeReply. */
      reply: PakeReply;
      /**
       * Verifies A's PakeFinish; on success the attempt count is cleared and
       * the device key can be added to the paired list. Null on a wrong tag.
       */
      confirm(finish: PakeFinish): Promise<{ deviceKey: Uint8Array; deviceName: string } | null>;
    };

/** Machine side (B): answer a PakeStart with one candidate per accepted step. */
export async function pakeReply(opts: {
  pairing: TotpPairing;
  machineKey: Uint8Array;
  start: PakeStart;
  now?: number;
}): Promise<MachinePake> {
  const now = opts.now ?? Date.now();
  const { pairing, start } = opts;
  const closed = pairing.check(now);
  if (closed !== null) return { ok: false, code: closed };
  if (start.sid.length !== 16 || start.staticKey.length !== 32 || start.share.length !== 32) {
    return { ok: false, code: HandshakeErrorCode.MALFORMED };
  }
  let ya: RPoint;
  try {
    ya = decodePoint(start.share);
  } catch {
    return { ok: false, code: HandshakeErrorCode.MALFORMED };
  }
  // Counted before any await: parallel attempts cannot slip past the lock,
  // and one that never sends PakeFinish still spends its try.
  pairing.fail(now);

  const keys: { isk: Uint8Array<ArrayBuffer>; t: Uint8Array<ArrayBuffer> }[] = [];
  const candidates: PakeCandidate[] = [];
  for (const code of pairing.codes(now)) {
    const y = randomScalar();
    const share = generator(code, start.sid).multiply(y).toBytes();
    let isk: Uint8Array<ArrayBuffer>;
    try {
      isk = await sessionKey(start.sid, ya.multiply(y), start.share, share);
    } catch {
      return { ok: false, code: HandshakeErrorCode.MALFORMED };
    }
    const t = await pakeTranscript(start, share, opts.machineKey);
    keys.push({ isk, t });
    candidates.push(create(PakeCandidateSchema, { share, tag: await hmac(isk, utf8("B"), t) }));
  }
  const reply = create(PakeReplySchema, { staticKey: opts.machineKey, candidates });
  let done = false;
  return {
    ok: true,
    reply,
    async confirm(finish) {
      if (done) return null;
      done = true;
      let ok = false;
      // Every candidate is checked, so timing does not tell which step matched.
      for (const k of keys) ok = equal(await hmac(k.isk, utf8("A"), k.t), finish.tag) || ok;
      if (!ok) return null;
      pairing.succeed();
      return { deviceKey: start.staticKey, deviceName: start.deviceName.slice(0, 64) };
    },
  };
}
