import { describe, expect, it } from "vitest";
import { dh, exportPrivateKey, generateKeyPair, importKeyPair } from "../src/index.ts";

describe("machine key storage", () => {
  it("exports and re-imports a static key with the same public half", async () => {
    const machine = await generateKeyPair(true);
    const restored = await importKeyPair(await exportPrivateKey(machine.privateKey));
    expect(restored.publicKey).toEqual(machine.publicKey);
    const peer = await generateKeyPair();
    expect(await dh(restored.privateKey, peer.publicKey)).toEqual(await dh(peer.privateKey, machine.publicKey));
  });

  it("refuses a low-order peer key", async () => {
    const me = await generateKeyPair();
    await expect(dh(me.privateKey, new Uint8Array(32))).rejects.toThrow();
  });
});
