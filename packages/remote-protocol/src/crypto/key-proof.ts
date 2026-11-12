// Proof that a device or a machine holds the private half of the X25519 key
// it registers with the chat (app.v1.KeyChallenge): the server sends a
// throwaway public key and a nonce, the caller answers
//   mac = HMAC-SHA256(key = X25519(own private key, server_key), nonce)
// and sends it back with the challenge unchanged (app.v1.KeyProof).
import { dh, hmac } from "./primitives.ts";

const KEY_LENGTH = 32;

/** The fields of app.v1.KeyChallenge the answer depends on. */
export type KeyChallengeInput = { serverKey: Uint8Array; nonce: Uint8Array };

/** The mac of app.v1.KeyProof for challenge, made with privateKey. */
export async function proveKeyPossession(privateKey: CryptoKey, challenge: KeyChallengeInput): Promise<Uint8Array<ArrayBuffer>> {
  if (challenge.serverKey.length !== KEY_LENGTH || challenge.nonce.length !== KEY_LENGTH) {
    throw new Error("bad key challenge");
  }
  const shared = await dh(privateKey, challenge.serverKey);
  return hmac(shared, challenge.nonce);
}
