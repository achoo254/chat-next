import { describe, expect, it } from "vitest";
import { concat, dh, generateKeyPair, hmac, importKeyPair, proveKeyPossession } from "../src/index.ts";

// The vector of server/internal/keyproof (TestVector): the chat checks the
// answer with the same formula, so devices, tunelo and the server agree.
const VECTOR = {
  clientPublic: "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c",
  serverPublic: "5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36",
  mac: "289ee0f2dcdf5cb02b6e7a540b3b33e0712573db03375eacda1d277b818b1bfc",
};

/** PKCS#8 of a raw X25519 private key (RFC 8410). */
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** 32 bytes counting up from first (mod 256). */
function seq(first: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: 32 }, (_, i) => (first + i) % 256);
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(s.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}

describe("key possession proof", () => {
  it("matches the server's vector", async () => {
    const client = await importKeyPair(concat(PKCS8_X25519, seq(1)));
    expect(hex(client.publicKey)).toBe(VECTOR.clientPublic);
    const mac = await proveKeyPossession(client.privateKey, { serverKey: fromHex(VECTOR.serverPublic), nonce: seq(201) });
    expect(hex(mac)).toBe(VECTOR.mac);
  });

  it("is what the server computes from its own half", async () => {
    const client = await generateKeyPair();
    const server = await generateKeyPair();
    const nonce = seq(9);
    const mac = await proveKeyPossession(client.privateKey, { serverKey: server.publicKey, nonce });
    const shared = await dh(server.privateKey, client.publicKey);
    expect(mac).toEqual(await hmac(shared, nonce));
    // Another key gives another answer.
    const other = await generateKeyPair();
    expect(await proveKeyPossession(other.privateKey, { serverKey: server.publicKey, nonce })).not.toEqual(mac);
  });

  it("refuses a malformed challenge", async () => {
    const client = await generateKeyPair();
    await expect(proveKeyPossession(client.privateKey, { serverKey: new Uint8Array(31), nonce: seq(0) })).rejects.toThrow();
    await expect(proveKeyPossession(client.privateKey, { serverKey: seq(5), nonce: new Uint8Array(16) })).rejects.toThrow();
    // A low-order point gives an all-zero secret, which X25519 refuses.
    await expect(proveKeyPossession(client.privateKey, { serverKey: new Uint8Array(32), nonce: seq(0) })).rejects.toThrow();
  });
});
