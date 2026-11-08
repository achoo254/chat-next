// Sealed frames after the handshake. Each direction has its own key and a
// counter that must go up by exactly one per frame: a replayed, dropped or
// reordered frame breaks the session instead of being accepted.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { concat, readU64, u64 } from "../bytes.ts";
import { open, seal } from "./primitives.ts";

export type Direction = "a-to-b" | "b-to-a";

export class FrameError extends Error {
  constructor(readonly reason: "replay" | "forged" | "malformed") {
    super(`frame rejected: ${reason}`);
  }
}

export type SessionKeys = {
  aToB: Uint8Array;
  bToA: Uint8Array;
  /** 15 bytes, shared by both sides; part of every nonce. */
  sessionId: Uint8Array;
};

export function frameNonce(sessionId: Uint8Array, dir: Direction, counter: bigint): Uint8Array {
  return concat(sessionId, Uint8Array.of(dir === "a-to-b" ? 0 : 1), u64(counter));
}

export function sealBytes(keys: SessionKeys, dir: Direction, counter: bigint, plaintext: Uint8Array): Uint8Array {
  const key = dir === "a-to-b" ? keys.aToB : keys.bToA;
  return concat(u64(counter), seal(key, frameNonce(keys.sessionId, dir, counter), plaintext));
}

export function openBytes(keys: SessionKeys, dir: Direction, expected: bigint, wire: Uint8Array): Uint8Array {
  if (wire.length < 8 + 16) throw new FrameError("malformed");
  const counter = readU64(wire);
  if (counter !== expected) throw new FrameError("replay");
  const key = dir === "a-to-b" ? keys.aToB : keys.bToA;
  const plain = open(key, frameNonce(keys.sessionId, dir, counter), wire.subarray(8));
  if (!plain) throw new FrameError("forged");
  return plain;
}

/** One side of an established link. Not safe to share between connections. */
export class Session {
  private sendCounter: bigint;
  private recvCounter: bigint;

  constructor(
    private readonly keys: SessionKeys,
    readonly side: "a" | "b",
    /** The peer's static public key (A's device key on B, B's machine key on A). */
    readonly peerStatic: Uint8Array,
  ) {
    // Frame 0 from B to A is the handshake confirmation.
    this.sendCounter = side === "b" ? 1n : 0n;
    this.recvCounter = side === "a" ? 1n : 0n;
  }

  get sessionId(): Uint8Array {
    return this.keys.sessionId;
  }

  seal(frame: Frame): Uint8Array {
    const dir: Direction = this.side === "a" ? "a-to-b" : "b-to-a";
    const wire = sealBytes(this.keys, dir, this.sendCounter, toBinary(FrameSchema, frame));
    this.sendCounter += 1n;
    return wire;
  }

  open(wire: Uint8Array): Frame {
    const dir: Direction = this.side === "a" ? "b-to-a" : "a-to-b";
    const plain = openBytes(this.keys, dir, this.recvCounter, wire);
    this.recvCounter += 1n;
    try {
      return fromBinary(FrameSchema, plain);
    } catch {
      throw new FrameError("malformed");
    }
  }
}
