import { create } from "@bufbuild/protobuf";
import { HandshakeErrorCode, PakeReplySchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import {
  PAIRING_LOCKOUT_MAX_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_ATTEMPTS,
  PakeFailure,
  TOTP_PERIOD_MS,
  TotpPairing,
  generateKeyPair,
  generateTotpSecret,
  pakeReply,
  pakeStart,
  random,
  totpCode,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;

async function setup() {
  const machine = await generateKeyPair();
  const device = await generateKeyPair();
  const secret = generateTotpSecret();
  const pairing = new TotpPairing(secret);
  return { machine, device, secret, pairing };
}

/** A code no accepted step of `secret` produces at NOW. */
function wrongCode(secret: Uint8Array): string {
  const accepted = new Set([-1, 0, 1].map((d) => totpCode(secret, NOW + d * TOTP_PERIOD_MS)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!accepted.has(code)) return code;
  }
}

async function attempt(opts: { pairing: TotpPairing; code: string; now?: number }) {
  const machine = await generateKeyPair();
  const device = await generateKeyPair();
  const a = await pakeStart({ code: opts.code, deviceKey: device.publicKey, deviceName: "x" });
  const b = await pakeReply({ pairing: opts.pairing, machineKey: machine.publicKey, start: a.start, now: opts.now ?? NOW });
  return { a, b, device, machine };
}

describe("pairing by authenticator code (CPace)", () => {
  it("pairs with the current code and pins the machine key", async () => {
    const { machine, device, secret, pairing } = await setup();
    const a = await pakeStart({ code: totpCode(secret, NOW), deviceKey: device.publicKey, deviceName: "phone" });
    const b = await pakeReply({ pairing, machineKey: machine.publicKey, start: a.start, now: NOW });
    if (!b.ok) throw new Error("expected reply");
    expect(b.reply.candidates).toHaveLength(3);
    const { machineKey, finish } = await a.finish(b.reply);
    expect(machineKey).toEqual(machine.publicKey);
    const paired = await b.confirm(finish);
    expect(paired?.deviceKey).toEqual(device.publicKey);
    expect(paired?.deviceName).toBe("phone");
    // The pairing stays open for the next device.
    expect(pairing.check(NOW)).toBeNull();
  });

  it.each([
    ["previous", -1],
    ["next", 1],
  ])("accepts the %s step's code (clock drift)", async (_name, drift) => {
    const { secret, pairing } = await setup();
    const { a, b } = await attempt({ pairing, code: totpCode(secret, NOW + drift * TOTP_PERIOD_MS) });
    if (!b.ok) throw new Error("expected reply");
    const { finish } = await a.finish(b.reply);
    expect(await b.confirm(finish)).not.toBeNull();
  });

  it("refuses a code two steps away", async () => {
    const { secret, pairing } = await setup();
    const code = totpCode(secret, NOW + 2 * TOTP_PERIOD_MS);
    const near = [-1, 0, 1].map((d) => totpCode(secret, NOW + d * TOTP_PERIOD_MS));
    expect(near).not.toContain(code);
    const { a, b } = await attempt({ pairing, code });
    if (!b.ok) throw new Error("expected reply");
    await expect(a.finish(b.reply)).rejects.toBeInstanceOf(PakeFailure);
  });

  it("fails a wrong code on the device side without telling which step", async () => {
    const { secret, pairing } = await setup();
    const { a, b } = await attempt({ pairing, code: wrongCode(secret) });
    if (!b.ok) throw new Error("expected reply");
    // Candidates and tags are all a relay sees; none checks for a wrong code.
    await expect(a.finish(b.reply)).rejects.toBeInstanceOf(PakeFailure);
  });

  it("locks pairing for 15 minutes after the first 5 attempts that did not pair", async () => {
    const { secret, pairing } = await setup();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      const { a, b } = await attempt({ pairing, code: wrongCode(secret) });
      if (!b.ok) throw new Error("expected reply");
      await expect(a.finish(b.reply)).rejects.toBeInstanceOf(PakeFailure);
    }
    // Even the right code is refused while locked, and not counted.
    const locked = await attempt({ pairing, code: totpCode(secret, NOW) });
    expect(locked.b.ok ? null : locked.b.code).toBe(HandshakeErrorCode.TOO_MANY_ATTEMPTS);
    expect(pairing.lockedUntil).toBe(NOW + PAIRING_LOCKOUT_MS);

    const later = NOW + PAIRING_LOCKOUT_MS;
    const { a, b } = await attempt({ pairing, code: totpCode(secret, later), now: later });
    if (!b.ok) throw new Error("expected reply after the lock");
    const { finish } = await a.finish(b.reply);
    expect(await b.confirm(finish)).not.toBeNull();
  });

  it("doubles the lock for each lock in a row, up to a day, and resets on success", () => {
    const pairing = new TotpPairing(generateTotpSecret());
    let now = NOW;
    const lockDurations: number[] = [];
    for (let lock = 0; lock < 9; lock++) {
      for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) pairing.fail(now);
      lockDurations.push(pairing.lockedUntil - now);
      now = pairing.lockedUntil;
    }
    expect(lockDurations.slice(0, 4)).toEqual([1, 2, 4, 8].map((n) => n * PAIRING_LOCKOUT_MS));
    expect(lockDurations.at(-1)).toBe(PAIRING_LOCKOUT_MAX_MS);
    expect(Math.max(...lockDurations)).toBe(PAIRING_LOCKOUT_MAX_MS);

    pairing.succeed();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) pairing.fail(now);
    expect(pairing.lockedUntil - now).toBe(PAIRING_LOCKOUT_MS);
  });

  it("counts a PakeStart that never finishes, and clears the count on success", async () => {
    const { secret, pairing } = await setup();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) {
      const { b } = await attempt({ pairing, code: wrongCode(secret) });
      expect(b.ok).toBe(true);
    }
    const good = await attempt({ pairing, code: totpCode(secret, NOW) });
    if (!good.b.ok) throw new Error("expected reply");
    const { finish } = await good.a.finish(good.b.reply);
    expect(await good.b.confirm(finish)).not.toBeNull();
    // The count starts over: 4 more wrong attempts do not lock.
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) await attempt({ pairing, code: wrongCode(secret) });
    expect(pairing.check(NOW)).toBeNull();
  });

  it("counts parallel attempts before any of them finishes", async () => {
    const { secret, pairing } = await setup();
    const results = await Promise.all(
      Array.from({ length: PAIRING_MAX_ATTEMPTS + 2 }, () => attempt({ pairing, code: totpCode(secret, NOW) })),
    );
    const refused = results.filter((r) => !r.b.ok);
    expect(refused).toHaveLength(2);
  });

  it("answers TOTP_NOT_SET, uncounted, while the machine has no secret", async () => {
    const pairing = new TotpPairing();
    expect(pairing.enabled).toBe(false);
    const { b } = await attempt({ pairing, code: "123456" });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.TOTP_NOT_SET);
    pairing.setSecret(generateTotpSecret());
    expect(pairing.enabled).toBe(true);
    expect(pairing.check(NOW)).toBeNull();
  });

  it("clears a lock when a new secret is set and refuses a bad one", async () => {
    const { secret, pairing } = await setup();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) await attempt({ pairing, code: wrongCode(secret) });
    expect(pairing.check(NOW)).toBe(HandshakeErrorCode.TOO_MANY_ATTEMPTS);
    pairing.setSecret(generateTotpSecret());
    expect(pairing.check(NOW)).toBeNull();
    expect(() => pairing.setSecret(new Uint8Array(16))).toThrow();
  });

  it("refuses a forged finish tag, once only", async () => {
    const { secret, pairing } = await setup();
    const { a, b } = await attempt({ pairing, code: totpCode(secret, NOW) });
    if (!b.ok) throw new Error("expected reply");
    const { finish } = await a.finish(b.reply);
    const forged = { ...finish, tag: random(32) };
    expect(await b.confirm(forged)).toBeNull();
    // A pending exchange answers one PakeFinish.
    expect(await b.confirm(finish)).toBeNull();
  });

  it("refuses a code from another machine's secret", async () => {
    const { pairing } = await setup();
    const { a, b } = await attempt({ pairing, code: totpCode(generateTotpSecret(), NOW) });
    if (!b.ok) throw new Error("expected reply");
    await expect(a.finish(b.reply)).rejects.toBeInstanceOf(PakeFailure);
  });

  it("refuses the identity point as a share, uncounted", async () => {
    const { machine, device, secret, pairing } = await setup();
    const a = await pakeStart({ code: totpCode(secret, NOW), deviceKey: device.publicKey, deviceName: "x" });
    a.start.share = new Uint8Array(32);
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      const b = await pakeReply({ pairing, machineKey: machine.publicKey, start: a.start, now: NOW });
      expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.MALFORMED);
    }
    expect(pairing.check(NOW)).toBeNull();
  });

  it("refuses a reply without candidates or with a bad machine key", async () => {
    const { device } = await setup();
    const a = await pakeStart({ code: "123456", deviceKey: device.publicKey, deviceName: "x" });
    await expect(a.finish(create(PakeReplySchema, { staticKey: random(32) }))).rejects.toBeInstanceOf(PakeFailure);
    await expect(a.finish(create(PakeReplySchema, { staticKey: random(5) }))).rejects.toBeInstanceOf(PakeFailure);
  });

  it("refuses a typed code that is not 6 digits", async () => {
    const { device } = await setup();
    await expect(pakeStart({ code: "12345", deviceKey: device.publicKey, deviceName: "x" })).rejects.toThrow();
    const ok = await pakeStart({ code: "123 456", deviceKey: device.publicKey, deviceName: "x" });
    expect(ok.start.sid).toHaveLength(16);
  });
});
