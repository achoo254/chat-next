// WebCrypto for X25519, HKDF, HMAC and SHA-256 (same code in browsers and
// Node); tweetnacl only for secretbox, which WebCrypto lacks.
import nacl from "tweetnacl";
import { concat, fromBase64Url } from "../bytes.ts";

const subtle = globalThis.crypto.subtle;

/** A static or ephemeral X25519 key. The private half may be non-extractable. */
export type KeyPair = { publicKey: Uint8Array<ArrayBuffer>; privateKey: CryptoKey };

export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const pair = (await subtle.generateKey({ name: "X25519" }, extractable, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { publicKey, privateKey: pair.privateKey };
}

/** PKCS#8 bytes of an extractable private key, for the machine's key store. */
export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.exportKey("pkcs8", key));
}

export async function importKeyPair(pkcs8: Uint8Array<ArrayBuffer>): Promise<KeyPair> {
  // Imported extractable once to read the public half (JWK "x"), then kept
  // as a non-extractable key for use.
  const probe = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", probe);
  if (!jwk.x) throw new Error("not an X25519 key");
  const publicKey = fromBase64Url(jwk.x);
  const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
  return { publicKey, privateKey };
}

export async function dh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (peerPublic.length !== 32) throw new Error("bad X25519 public key");
  const pub = await subtle.importKey("raw", new Uint8Array(peerPublic), { name: "X25519" }, false, []);
  // Rejects low-order points (all-zero shared secret) as WebCrypto requires.
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256));
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}

export async function hmac(key: Uint8Array<ArrayBuffer>, ...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, concat(...parts)));
}

export async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, length * 8));
}

export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return nacl.secretbox(plaintext, nonce, key);
}

/** Returns null when the box was forged or the key/nonce is wrong. */
export function open(key: Uint8Array, nonce: Uint8Array, box: Uint8Array): Uint8Array | null {
  return nacl.secretbox.open(box, nonce, key);
}
