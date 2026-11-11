// Terminal frames of docs/terminal-wire.md section 3, as a client builds and
// reads them (only what the tests need).

export const T = {
  HELLO: 0x01,
  INPUT: 0x10,
  RESIZE: 0x11,
  ATTACH: 0x12,
  ACK: 0x14,
  PING: 0x15,
  S_HELLO: 0x81,
  OUTPUT: 0x90,
  SNAPSHOT: 0x91,
  EXIT: 0x92,
  PONG: 0x95,
  ERROR: 0x9f,
} as const;

function header(type: number, session: number, extra: number): { buf: Uint8Array; view: DataView } {
  const buf = new Uint8Array(5 + extra);
  const view = new DataView(buf.buffer);
  view.setUint8(0, type);
  view.setUint32(1, session);
  return { buf, view };
}

export function helloFrame(): Uint8Array {
  const { buf } = header(T.HELLO, 0, 2);
  buf[5] = 1; // version
  buf[6] = 0; // caps
  return buf;
}

export function inputFrame(session: number, text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  const { buf } = header(T.INPUT, session, data.length);
  buf.set(data, 5);
  return buf;
}

export function attachFrame(session: number, lastOffset: bigint): Uint8Array {
  const { buf, view } = header(T.ATTACH, session, 8);
  view.setBigUint64(5, lastOffset);
  return buf;
}

export function ackFrame(session: number, offset: bigint): Uint8Array {
  const { buf, view } = header(T.ACK, session, 8);
  view.setBigUint64(5, offset);
  return buf;
}

export function pingFrame(micros: bigint): Uint8Array {
  const { buf, view } = header(T.PING, 0, 8);
  view.setBigUint64(5, micros);
  return buf;
}

export type ServerFrame =
  | { type: "hello" }
  | { type: "output"; session: number; offset: bigint; data: Uint8Array }
  | { type: "snapshot"; session: number; offset: bigint; vt: Uint8Array }
  | { type: "exit"; session: number; code: number }
  | { type: "pong"; micros: bigint }
  | { type: "error"; session: number; code: number; message: string }
  | { type: "other"; code: number };

export function readServerFrame(f: Uint8Array): ServerFrame {
  const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const type = view.getUint8(0);
  const session = view.getUint32(1);
  switch (type) {
    case T.S_HELLO:
      return { type: "hello" };
    case T.OUTPUT:
      return { type: "output", session, offset: view.getBigUint64(5), data: f.subarray(13) };
    case T.SNAPSHOT:
      return { type: "snapshot", session, offset: view.getBigUint64(5), vt: f.subarray(18) };
    case T.EXIT:
      return { type: "exit", session, code: view.getInt32(5) };
    case T.PONG:
      return { type: "pong", micros: view.getBigUint64(5) };
    case T.ERROR:
      return { type: "error", session, code: view.getUint16(5), message: new TextDecoder().decode(f.subarray(7)) };
    default:
      return { type: "other", code: type };
  }
}

/** An Output frame as the terminal process writes it (for the fake one). */
export function outputFrame(session: number, offset: bigint, data: Uint8Array): Uint8Array {
  const { buf, view } = header(T.OUTPUT, session, 8 + data.length);
  view.setBigUint64(5, offset);
  buf.set(data, 13);
  return buf;
}

export function serverHelloFrame(): Uint8Array {
  const { buf, view } = header(T.S_HELLO, 0, 5);
  buf[5] = 1;
  view.setUint32(6, 65536);
  return buf;
}
