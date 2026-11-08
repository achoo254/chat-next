import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { PairingWindow, PakeFailure, decodeQr, encodeQr, generateKeyPair, pakeReply, pakeStart, random } from "../src/index.ts";

describe("6-digit code pairing (CPace)", () => {
  it("pairs when both sides use the same code", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const window = PairingWindow.open();
    expect(window.code).toMatch(/^\d{6}$/);

    const a = await pakeStart({ code: window.code, deviceKey: device.publicKey, deviceName: "phone" });
    const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start });
    if (!b.ok) throw new Error("expected reply");
    const { machineKey, finish } = await a.finish(b.reply);
    expect(machineKey).toEqual(machine.publicKey);
    const paired = await b.confirm(finish);
    expect(paired?.deviceKey).toEqual(device.publicKey);
    expect(paired?.deviceName).toBe("phone");
    expect(window.check(Date.now())).toBe(HandshakeErrorCode.PAIRING_EXPIRED);
  });

  it("fails on a wrong code without revealing it, and stops after 5 tries", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const window = PairingWindow.open();
    const wrong = window.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      const a = await pakeStart({ code: wrong, deviceKey: device.publicKey, deviceName: "x" });
      const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start });
      if (!b.ok) throw new Error("expected reply");
      // B's share and tag are all a relay sees; A cannot verify the tag.
      await expect(a.finish(b.reply)).rejects.toBeInstanceOf(PakeFailure);
    }
    const a = await pakeStart({ code: window.code, deviceKey: device.publicKey, deviceName: "x" });
    const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.TOO_MANY_ATTEMPTS);
  });

  it("refuses a forged finish tag", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const window = PairingWindow.open();
    const a = await pakeStart({ code: window.code, deviceKey: device.publicKey, deviceName: "x" });
    const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start });
    if (!b.ok) throw new Error("expected reply");
    const { finish } = await a.finish(b.reply);
    finish.tag = random(32);
    expect(await b.confirm(finish)).toBeNull();
  });

  it("refuses the identity point as a share", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const window = PairingWindow.open();
    const a = await pakeStart({ code: window.code, deviceKey: device.publicKey, deviceName: "x" });
    a.start.share = new Uint8Array(32);
    const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.MALFORMED);
  });

  it("expires after 10 minutes", async () => {
    const machine = await generateKeyPair();
    const window = PairingWindow.open(0);
    const a = await pakeStart({ code: window.code, deviceKey: machine.publicKey, deviceName: "x" });
    const b = await pakeReply({ window, machineKey: machine.publicKey, start: a.start, now: 10 * 60 * 1000 });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.PAIRING_EXPIRED);
  });
});

describe("QR text", () => {
  it("round-trips and rejects junk", () => {
    const key = random(32);
    const secret = random(32);
    const text = encodeQr(key, secret);
    expect(decodeQr(text)).toEqual({ machineKey: key, secret });
    expect(() => decodeQr("hrp1.abc.def")).toThrow();
    expect(() => decodeQr("https://example.com")).toThrow();
  });
});
