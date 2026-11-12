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
  equal,
  generateKeyPair,
  startHandshake,
} from "../src/index.ts";

const ping = (id: string) => create(FrameSchema, { id, body: { case: "ping", value: {} } });

/** A machine whose owner's account lists the device as trusted. */
async function setup() {
  const machine = await generateKeyPair();
  const device = await generateKeyPair();
  const trusted: Uint8Array[] = [device.publicKey];
  const deviceStatus = (k: Uint8Array): DeviceStatus => (trusted.some((p) => equal(p, k)) ? "trusted" : "unknown");
  return { machine, device, deviceStatus };
}

describe("handshake", () => {
  it("opens a session both ways with the machine key the chat lists", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.deviceKey).toEqual(device.publicKey);
    const { session: sa } = await a.finish(b.reply);

    const got = b.session.open(sa.seal(ping("1")));
    expect(got.id).toBe("1");
    expect(sa.open(b.session.seal(ping("2"))).id).toBe("2");
    expect(sa.open(b.session.seal(ping("3"))).id).toBe("3");
  });

  it("refuses a device the owner's account does not list", async () => {
    const { machine, deviceStatus } = await setup();
    const stranger = await generateKeyPair();
    const a = await startHandshake({ device: stranger, expectedMachineKey: machine.publicKey });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.code).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.UNKNOWN_DEVICE });
  });

  it("refuses a revoked device apart from an unknown one", async () => {
    const { machine, device } = await setup();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    const b = await acceptHello(a.hello, { machine, deviceStatus: () => "revoked" });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.REVOKED);
    if (b.ok) return;
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.REVOKED });
  });

  it("stops at a machine key other than the one the chat lists", async () => {
    const { machine, device, deviceStatus } = await setup();
    const other = await generateKeyPair();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    // Another machine (or one that changed its key) answers.
    const b = await acceptHello(a.hello, { machine: other, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    await expect(a.finish(b.reply)).rejects.toMatchObject({ code: HandshakeErrorCode.MACHINE_KEY_CHANGED });
  });

  it("detects a relay that claims the listed key without holding it", async () => {
    const { machine, device, deviceStatus } = await setup();
    const impostor = await generateKeyPair();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    const b = await acceptHello(a.hello, { machine: impostor, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    const plain = decodePlain(b.reply);
    if (plain.body.case !== "ready") throw new Error("expected ready");
    plain.body.value.staticKey = machine.publicKey;
    await expect(a.finish(encodePlain(plain.body))).rejects.toMatchObject({ code: HandshakeErrorCode.BAD_PROOF });
  });

  it("detects a relay that rewrites the Ready keys", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    const b = await acceptHello(a.hello, { machine, deviceStatus });
    if (!b.ok) throw new Error("expected ready");
    const plain = decodePlain(b.reply);
    if (plain.body.case !== "ready") throw new Error("expected ready");
    plain.body.value.ephemeralKey = (await generateKeyPair()).publicKey;
    await expect(a.finish(encodePlain(plain.body))).rejects.toBeInstanceOf(HandshakeFailure);
  });

  it("refuses a malformed expected machine key", async () => {
    const device = await generateKeyPair();
    await expect(startHandshake({ device, expectedMachineKey: new Uint8Array(31) })).rejects.toMatchObject({
      code: HandshakeErrorCode.MALFORMED,
    });
  });

  it("rejects replayed, reordered and forged frames", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
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
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
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

  it("refuses a peer that only speaks protocol 2", async () => {
    const { machine, device, deviceStatus } = await setup();
    const a = await startHandshake({ device, expectedMachineKey: machine.publicKey });
    const plain = decodePlain(a.hello);
    if (plain.body.case !== "hello") throw new Error("expected hello");
    const old = create(HelloSchema, { ...plain.body.value, protocolVersion: 2, minProtocolVersion: 2 });
    const b = await acceptHello(encodePlain({ case: "hello", value: old }), { machine, deviceStatus });
    expect(b.ok ? null : b.code).toBe(HandshakeErrorCode.VERSION_UNSUPPORTED);
    expect(PROTOCOL_VERSION).toBe(3);
    expect(MIN_PROTOCOL_VERSION).toBe(3);
  });
});
