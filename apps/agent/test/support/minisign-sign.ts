// A throwaway minisign key for tests: signs files the way `minisign -S`
// does (BLAKE2b-prehashed Ed25519, trusted comment signed globally), so
// update.ts can be exercised without the release key.
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export type TestSigner = {
  /** The public key line, as `minisign -G` writes it. */
  pubkey: string;
  /** A `.minisig` file for `file` with `comment` as its trusted comment. */
  sign: (file: Uint8Array, comment: string) => string;
};

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ascii = (s: string) => new TextEncoder().encode(s);

export function testSigner(): TestSigner {
  const secret = ed25519.utils.randomSecretKey();
  const keyId = crypto.getRandomValues(new Uint8Array(8));
  return {
    pubkey: base64(concat(ascii("Ed"), keyId, ed25519.getPublicKey(secret))),
    sign: (file, comment) => {
      const signature = ed25519.sign(blake2b(file, { dkLen: 64 }), secret);
      const global = ed25519.sign(concat(signature, ascii(comment)), secret);
      return [
        "untrusted comment: signature from a test key",
        base64(concat(ascii("ED"), keyId, signature)),
        `trusted comment: ${comment}`,
        base64(global),
        "",
      ].join("\n");
    },
  };
}
