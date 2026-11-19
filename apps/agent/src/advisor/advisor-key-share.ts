// The account's TypeSafe key handed from one machine to another: the device
// that relays it, and the server under that device, only ever carry sealed
// bytes.
//
// The machine that receives makes a fresh X25519 key pair for one hand-off (a
// ticket) and gives its public half to the device over that device's own
// end-to-end link, so the server cannot swap it. The machine that holds the
// key seals it for that public key with an ephemeral key pair of its own:
//
//   sealed = 1 || ephemeral public (32) || nonce (24) || secretbox(payload)
//   box key = HKDF-SHA256(X25519(ephemeral, ticket), salt: ephemeral public
//             || ticket public, info: "tunelo advisor key share v1")
//
// The payload is the key, the time it counts as set and the device that set
// it, so every machine orders the account's keys the same way. The receiver
// opens it with the ticket's private half, which never leaves this process and
// is used once.
//
// What this does not stop: the holder cannot tell a ticket's public key from
// one the device made itself, so a device the machine trusts (a stolen one, a
// web page running someone else's script, a device key slipped into the
// trusted list by whoever runs the server) can have the key sealed for itself
// and open it. Both machines log every hand-off with the ticket's tag
// (ticketTag): a "sent" line on the holder with no "received" line of the same
// tag on any machine is a key that went somewhere else.
import { createHash } from "node:crypto";
import {
  type KeyPair,
  concat,
  dh,
  generateKeyPair,
  hkdf,
  open,
  random,
  seal,
  utf8,
} from "@achoo254/chat-remote-protocol";
import type { SharedAdvisorKey } from "./advisor-key-store.ts";

const VERSION = 1;
const PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const BOX_KEY_BYTES = 32;
const INFO = utf8("tunelo advisor key share v1");
/** The most sealed bytes taken: a 4096-character key and its note fit with room to spare. */
export const MAX_SEALED_BYTES = 8192;
/** How long a ticket waits for its sealed key. */
export const TICKET_TTL_MS = 120_000;
/** Tickets one link holds at once; the oldest is dropped for a new one. */
export const MAX_TICKETS = 4;
/** The longest device label kept from a payload. */
const MAX_DEVICE_CHARS = 200;
/** Hex characters of a ticket public key's SHA-256 written to the audit log. */
const TICKET_TAG_CHARS = 12;

/** A hand-off that cannot go on. The message is fixed: it never quotes a key. */
export class AdvisorKeyShareError extends Error {
  constructor(readonly kind: "failed" | "bad_public_key") {
    super(kind === "failed" ? "the sealed key does not open with this machine's ticket; nothing was saved" : "the public key to seal for is not 32 bytes");
  }
}

async function boxKey(privateKey: CryptoKey, peerPublic: Uint8Array, senderPublic: Uint8Array, recipientPublic: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const shared = await dh(privateKey, peerPublic);
  return hkdf(shared, concat(senderPublic, recipientPublic), INFO, BOX_KEY_BYTES);
}

/**
 * The tag both machines log for one hand-off: the start of the SHA-256 of
 * the ticket's public key. AdvisorKeyShareError "bad_public_key" for a key
 * that is not 32 bytes.
 */
export function ticketTag(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new AdvisorKeyShareError("bad_public_key");
  return createHash("sha256").update(publicKey).digest("hex").slice(0, TICKET_TAG_CHARS);
}

/** Seals the account's key for a ticket's public key of another machine. */
export async function sealAdvisorKey(recipientPublic: Uint8Array, shared: SharedAdvisorKey): Promise<Uint8Array<ArrayBuffer>> {
  if (recipientPublic.length !== PUBLIC_KEY_BYTES) throw new AdvisorKeyShareError("bad_public_key");
  const ephemeral = await generateKeyPair();
  const key = await boxKey(ephemeral.privateKey, recipientPublic, ephemeral.publicKey, recipientPublic);
  const nonce = random(NONCE_BYTES);
  const payload = utf8(JSON.stringify({ key: shared.key, setAt: shared.setAt, setByDevice: shared.setByDevice }));
  return concat(Uint8Array.of(VERSION), ephemeral.publicKey, nonce, seal(key, nonce, payload));
}

/** What a payload holds, checked field by field; undefined for anything else. */
function payloadOf(bytes: Uint8Array): SharedAdvisorKey | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { key, setAt, setByDevice } = parsed as { key?: unknown; setAt?: unknown; setByDevice?: unknown };
  if (typeof key !== "string" || typeof setAt !== "number" || !Number.isSafeInteger(setAt) || setAt < 0) return undefined;
  if (typeof setByDevice !== "string" || setByDevice.length > MAX_DEVICE_CHARS) return undefined;
  return { key, setAt, setByDevice };
}

/** Opens sealed bytes with a ticket; AdvisorKeyShareError "failed" for bytes that do not open or hold no key. */
export async function openAdvisorKey(ticket: KeyPair, sealed: Uint8Array): Promise<SharedAdvisorKey> {
  const head = 1 + PUBLIC_KEY_BYTES + NONCE_BYTES;
  if (sealed.length <= head || sealed.length > MAX_SEALED_BYTES || sealed[0] !== VERSION) throw new AdvisorKeyShareError("failed");
  const senderPublic = sealed.slice(1, 1 + PUBLIC_KEY_BYTES);
  const nonce = sealed.slice(1 + PUBLIC_KEY_BYTES, head);
  let key: Uint8Array;
  try {
    key = await boxKey(ticket.privateKey, senderPublic, senderPublic, ticket.publicKey);
  } catch {
    // A low-order or malformed public key: WebCrypto refuses it.
    throw new AdvisorKeyShareError("failed");
  }
  const plain = open(key, nonce, sealed.slice(head));
  const payload = plain === null ? undefined : payloadOf(plain);
  if (payload === undefined) throw new AdvisorKeyShareError("failed");
  return payload;
}

type Ticket = { pair: KeyPair; expires: number };

/** One link's tickets: each opens one sealed key, within TICKET_TTL_MS. */
export class AdvisorKeyTickets {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new ticket: its id and the public half to hand to the machine that seals. */
  async begin(): Promise<{ ticketId: string; publicKey: Uint8Array<ArrayBuffer> }> {
    this.drop();
    const pair = await generateKeyPair();
    const ticketId = Buffer.from(random(16)).toString("base64url");
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next();
      if (oldest.done === true) break;
      this.tickets.delete(oldest.value);
    }
    this.tickets.set(ticketId, { pair, expires: this.now() + TICKET_TTL_MS });
    return { ticketId, publicKey: pair.publicKey };
  }

  /** The ticket's key pair, once; undefined when unknown, used or expired. */
  take(ticketId: string): KeyPair | undefined {
    this.drop();
    const ticket = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    return ticket?.pair;
  }

  private drop(): void {
    const now = this.now();
    for (const [id, t] of this.tickets) if (t.expires <= now) this.tickets.delete(id);
  }
}
