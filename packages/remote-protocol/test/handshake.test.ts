import { create } from "@bufbuild/protobuf";
import { FrameSchema, HandshakeErrorCode, HelloSchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import {
  type DeviceStatus,
  FrameError,
  HandshakeFailure,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  acceptHello,
  decodePlain,
  encodePlain,
  generateKeyPair,
  random,
  startHandshake,
} from "../src/index.ts";

const ping = (id: string) => create(FrameSchema, { id, body: { case: "ping", value: {} } });

async function setup() {
  const machine = await generateKeyPair();
  const device = await generateKeyPair();
  const paired: Uint8Array[] = [device.publicKey];
  const deviceStatus = (k: Uint8Array): DeviceStatus =>
    paired.some((p) => p.every((x, i) => x === k[i])) ? "paired" : "unknown";
  return { machine, device, deviceStatus };
}

describe("handshake", () => {
  it("opens a session both ways with a pinned machine key", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, deviceName: "phone", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const { session: sa } = await a.finish(b.reply);
    expect(b.deviceName).toBe("phone");

    const got = b.session.open(sa.seal(ping("1")));
    expect(got.id).toBe("1");
    expect(sa.open(b.session.seal(ping("2"))).id).toBe("2");
    expect(sa.open(b.session.seal(ping("3"))).id).toBe("3");
  });

  it("refuses an unpaired device", async () => {
    const { machine, deviceStatus } = await setup();
    const stranger = await generateKeyPair();
    const a = await startHandshake({ device: stranger, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.code).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.UNKNOWN_DEVICE });
  });

  it("refuses a revoked device", async () => {
    const { machine, device } = await setup();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus: () => "revoked" });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.REVOKED);
  });

  it("detects a machine impersonator (wrong static key)", async () => {
    const { machine, device, deviceStatus } = await setup();
    const fake = await generateKeyPair();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine: fake, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.BAD_PROOF });
  });

  it("detects a relay that rewrites the Ready keys", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    const plain = decodePlain(b.reply);
    if (plain.body.case !== "ready") throw new Error("expected ready");
    plain.body.value.ephemeralKey = (await generateKeyPair()).publicKey;
    await expect(a.finish(encodePlain(plain.body))).rejects.toBeInstanceOf(HandshakeFailure);
  });

  it("rejects replayed, reordered and forged frames", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    const { session: sa } = await a.finish(b.reply);

    const f1 = sa.seal(ping("1"));
    const f2 = sa.seal(ping("2"));
    expect(() => b.session.open(f2)).toThrow(FrameError); // reordered
    b.session.open(f1);
    expect(() => b.session.open(f1)).toThrow(FrameError); // replayed
    const forged = sa.seal(ping("3"));
    forged.set([(forged.at(-1) ?? 0) ^ 1], forged.length - 1);
    expect(() => b.session.open(f2)).not.toThrow();
    expect(() => b.session.open(forged)).toThrow(/forged/);
  });

  it("reports an unsupported protocol version on both sides", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const plain = decodePlain(a.hello);
    if (plain.body.case !== "hello") throw new Error();
    const future = create(HelloSchema, { ...plain.body.value, protocolVersion: 9, minProtocolVersion: PROTOCOL_VERSION + 1 });
    const b = await acceptHello(encodePlain({ case: "hello", value: future }), { machine, deviceStatus });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.VERSION_UNSUPPORTED);
    if (b.ok) return;
    const err = decodePlain(b.reply);
    expect(err.body.case === "error" && err.body.value.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(err.body.case === "error" && err.body.value.minProtocolVersion).toBe(MIN_PROTOCOL_VERSION);
  });
});

describe("install pairing", () => {
  it("lets the installing browser pin the machine key after the proof checks", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const secret = random(32);
    const a = await startHandshake({ device, deviceName: "laptop", trust: { kind: "install", secret } });
    const b = await acceptHello(a.hello, {
      machine,
      deviceStatus: () => "unknown",
      install: { deviceKey: device.publicKey, secret },
    });
    if (!b.ok) throw new Error("expected ready");
    expect(b.pairedBy).toBe("install");
    const { machineKey } = await a.finish(b.reply);
    expect(machineKey).toEqual(machine.publicKey);
  });

  it("refuses a machine that does not know the install secret", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const a = await startHandshake({ device, deviceName: "laptop", trust: { kind: "install", secret: random(32) } });
    const b = await acceptHello(a.hello, {
      machine,
      deviceStatus: () => "unknown",
      install: { deviceKey: device.publicKey, secret: random(32) },
    });
    if (!b.ok) throw new Error("expected ready");
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.BAD_PROOF });
  });
});

describe("new devices", () => {
  it("refuses an unknown device even while an install is pending for another key", async () => {
    const machine = await generateKeyPair();
    const installer = await generateKeyPair();
    const stranger = await generateKeyPair();
    const secret = random(32);
    const a = await startHandshake({ device: stranger, deviceName: "x", trust: { kind: "install", secret } });
    const b = await acceptHello(a.hello, {
      machine,
      deviceStatus: () => "unknown",
      install: { deviceKey: installer.publicKey, secret },
    });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
  });

  it("does not mark a paired device as newly paired", async () => {
    const machine = await generateKeyPair();
    const device = await generateKeyPair();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const b = await acceptHello(a.hello, { machine, deviceStatus: () => "paired" });
    if (!b.ok) throw new Error("expected ready");
    expect(b.pairedBy).toBeUndefined();
  });

  it("refuses a peer that only speaks protocol 1", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, deviceName: "x", trust: { kind: "pinned", machineKey: machine.publicKey } });
    const plain = decodePlain(a.hello);
    if (plain.body.case !== "hello") throw new Error("expected hello");
    const old = create(HelloSchema, { ...plain.body.value, protocolVersion: 1, minProtocolVersion: 1 });
    const b = await acceptHello(encodePlain({ case: "hello", value: old }), { machine, deviceStatus });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.VERSION_UNSUPPORTED);
    expect(PROTOCOL_VERSION).toBe(2);
    expect(MIN_PROTOCOL_VERSION).toBe(2);
  });
});
