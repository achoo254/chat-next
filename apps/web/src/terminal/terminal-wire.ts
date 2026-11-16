// Terminal frames between this page and the machine's terminal process
// (docs/terminal-wire.md, section 3): a 5-byte header (type u8, session u32)
// and the frame's data, every integer big-endian. This side only encodes what
// a client sends and decodes what the terminal process sends; a malformed
// frame from the machine decodes to null and never throws.

/** Largest frame, header included. */
export const MAX_FRAME = 65_536;
/** Largest keystroke payload of one Input frame. */
export const MAX_INPUT = 8_192;
export const WIRE_VERSION = 1;
export const HEADER_LEN = 5;
/** Columns and rows of a terminal: 1 to 1000 each. */
export const MAX_DIM = 1_000;
/** Most rows one HistoryRequest may ask for. */
export const MAX_HISTORY_ROWS = 500;
/**
 * Hello capability: this client takes a LiveSnapshot for a fresh attach on the normal screen and asks for older rows
 * with HistoryRequest (docs/terminal-wire.md section 4).
 */
export const CAP_LIVE_HISTORY = 0x01;

export const ClientType = {
	hello: 0x01,
	input: 0x10,
	resize: 0x11,
	attach: 0x12,
	detach: 0x13,
	ack: 0x14,
	ping: 0x15,
	preview: 0x16,
	historyRequest: 0x17,
} as const;

export const ServerType = {
	hello: 0x81,
	output: 0x90,
	snapshot: 0x91,
	exit: 0x92,
	preview: 0x93,
	liveSnapshot: 0x94,
	pong: 0x95,
	history: 0x96,
	historyError: 0x97,
	error: 0x9f,
} as const;

/** Error codes of an Error frame. */
export const TermErrorCode = {
	noSuchSession: 1,
	sessionLimit: 2,
	badFrame: 3,
	badVersion: 4,
	notAttached: 5,
	revoked: 6,
} as const;

/** Codes of a HistoryError frame. */
export const HistoryErrorCode = {
	unavailable: 1,
	busy: 2,
	cancelled: 3,
} as const;

export type ServerFrame =
	/** `caps`: the machine's capability bits, null when its Hello carried none (an older machine, or caps 0 sent). */
	| { readonly type: "hello"; readonly version: number; readonly maxFrame: number; readonly caps: number | null }
	/** `offset`: the session's output offset of the first byte of `data`. */
	| { readonly type: "output"; readonly session: number; readonly offset: number; readonly data: Uint8Array }
	/** `offset`: where the next Output starts; `vt` rebuilds the screen after a resize to cols × rows. */
	| {
			readonly type: "snapshot";
			readonly session: number;
			readonly offset: number;
			readonly cols: number;
			readonly rows: number;
			readonly altScreen: boolean;
			readonly vt: Uint8Array;
	  }
	/**
	 * The session as the machine's emulator renders it now, laid out like a snapshot: shown at once while the whole
	 * stream replays out of sight, never applied to it. `offset`: the output offset the rendering reflects.
	 */
	| {
			readonly type: "preview";
			readonly session: number;
			readonly offset: number;
			readonly cols: number;
			readonly rows: number;
			readonly altScreen: boolean;
			readonly vt: Uint8Array;
	  }
	/**
	 * The screen as it is now, where a fresh attach on the normal screen starts (CAP_LIVE_HISTORY): the parts' `vt`
	 * joined in `part` order is written to the terminal, then Output follows from `offset`. History rows before
	 * `historyEnd` of `epoch` are asked for with HistoryRequest; `tailRows` rows from it are already in `vt`.
	 */
	| {
			readonly type: "liveSnapshot";
			readonly session: number;
			readonly offset: number;
			readonly cols: number;
			readonly rows: number;
			readonly epoch: number;
			readonly historyEnd: number;
			readonly tailRows: number;
			readonly part: number;
			readonly parts: number;
			readonly vt: Uint8Array;
	  }
	/** `rowCount` rows from `firstRow` of `epoch`, oldest first, each ending in CR LF, split over `parts` frames. */
	| {
			readonly type: "history";
			readonly session: number;
			readonly reqId: number;
			readonly epoch: number;
			readonly firstRow: number;
			readonly rowCount: number;
			readonly part: number;
			readonly parts: number;
			readonly atStart: boolean;
			readonly vt: Uint8Array;
	  }
	| { readonly type: "historyError"; readonly session: number; readonly reqId: number; readonly code: number }
	| { readonly type: "exit"; readonly session: number; readonly code: number; readonly signal: number }
	| { readonly type: "pong"; readonly micros: number }
	| { readonly type: "error"; readonly session: number; readonly code: number; readonly message: string }
	/** A type this client does not know: ignored, never an error (the spec allows new ones). */
	| { readonly type: "unknown"; readonly frameType: number };

const TWO_32 = 2 ** 32;
/** A u64 whose high word is at most this fits a JavaScript number exactly. */
const MAX_SAFE_HIGH = 2 ** 21 - 1;

const utf8 = new TextDecoder("utf-8", { fatal: false });

function isU32(n: number): boolean {
	return Number.isInteger(n) && n >= 0 && n < TWO_32;
}

function isU64(n: number): boolean {
	return Number.isSafeInteger(n) && n >= 0;
}

function frame(type: number, session: number, payloadLength: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
	if (!isU32(session)) throw new RangeError(`terminal session ${session} is not a u32`);
	const bytes = new Uint8Array(HEADER_LEN + payloadLength);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, type);
	view.setUint32(1, session);
	return { bytes, view };
}

function setU64(view: DataView, at: number, n: number): void {
	if (!isU64(n)) throw new RangeError(`${n} is not a u64 this client can hold`);
	view.setUint32(at, Math.floor(n / TWO_32));
	view.setUint32(at + 4, n % TWO_32);
}

/** A u64 as a number; null beyond 2^53 (no terminal ever gets there). */
function getU64(view: DataView, at: number): number | null {
	const high = view.getUint32(at);
	if (high > MAX_SAFE_HIGH) return null;
	return high * TWO_32 + view.getUint32(at + 4);
}

/** `caps`: capability bits this client takes (CAP_LIVE_HISTORY); a machine that knows none of them ignores them. */
export function encodeHello(caps = 0): Uint8Array<ArrayBuffer> {
	const { bytes, view } = frame(ClientType.hello, 0, 2);
	view.setUint8(HEADER_LEN, WIRE_VERSION);
	view.setUint8(HEADER_LEN + 1, caps);
	return bytes;
}

/** Keystrokes; at most MAX_INPUT bytes (split longer pastes first). */
export function encodeInput(session: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
	if (data.length > MAX_INPUT) throw new RangeError(`input of ${data.length} bytes is over ${MAX_INPUT}`);
	const { bytes } = frame(ClientType.input, session, data.length);
	bytes.set(data, HEADER_LEN);
	return bytes;
}

export function encodeResize(session: number, cols: number, rows: number): Uint8Array<ArrayBuffer> {
	if (!validDim(cols) || !validDim(rows)) throw new RangeError(`terminal size ${cols}x${rows} is outside 1-${MAX_DIM}`);
	const { bytes, view } = frame(ClientType.resize, session, 4);
	view.setUint16(HEADER_LEN, cols);
	view.setUint16(HEADER_LEN + 2, rows);
	return bytes;
}

/** `lastOffset`: output applied so far (0: nothing, the machine sends a snapshot). */
export function encodeAttach(session: number, lastOffset: number): Uint8Array<ArrayBuffer> {
	const { bytes, view } = frame(ClientType.attach, session, 8);
	setU64(view, HEADER_LEN, lastOffset);
	return bytes;
}

/** Asks for the session as the machine renders it now (answered with a preview by tunelo 3.5.0+, ignored before). */
export function encodePreview(session: number): Uint8Array<ArrayBuffer> {
	return frame(ClientType.preview, session, 0).bytes;
}

/** Up to `maxRows` (1-500) history rows of `epoch` just before row `beforeRow`, on an attached session. */
export function encodeHistoryRequest(
	session: number,
	reqId: number,
	epoch: number,
	beforeRow: number,
	maxRows: number,
): Uint8Array<ArrayBuffer> {
	if (!Number.isInteger(reqId) || reqId < 0 || reqId > 0xffff) throw new RangeError(`request id ${reqId} is not a u16`);
	if (!isU32(epoch)) throw new RangeError(`epoch ${epoch} is not a u32`);
	if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_HISTORY_ROWS) {
		throw new RangeError(`${maxRows} history rows is outside 1-${MAX_HISTORY_ROWS}`);
	}
	const { bytes, view } = frame(ClientType.historyRequest, session, 16);
	view.setUint16(HEADER_LEN, reqId);
	view.setUint32(HEADER_LEN + 2, epoch);
	setU64(view, HEADER_LEN + 6, beforeRow);
	view.setUint16(HEADER_LEN + 14, maxRows);
	return bytes;
}

export function encodeDetach(session: number): Uint8Array<ArrayBuffer> {
	return frame(ClientType.detach, session, 0).bytes;
}

export function encodeAck(session: number, offset: number): Uint8Array<ArrayBuffer> {
	const { bytes, view } = frame(ClientType.ack, session, 8);
	setU64(view, HEADER_LEN, offset);
	return bytes;
}

export function encodePing(micros: number): Uint8Array<ArrayBuffer> {
	const { bytes, view } = frame(ClientType.ping, 0, 8);
	setU64(view, HEADER_LEN, micros);
	return bytes;
}

export function validDim(n: number): boolean {
	return Number.isInteger(n) && n >= 1 && n <= MAX_DIM;
}

/**
 * One frame from the terminal process; null when it is malformed (too short
 * or long for its type, a value out of range, the session where none belongs).
 */
export function decodeServerFrame(buf: Uint8Array): ServerFrame | null {
	if (buf.length < HEADER_LEN || buf.length > MAX_FRAME) return null;
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const type = view.getUint8(0);
	const session = view.getUint32(1);
	const size = buf.length - HEADER_LEN;
	const p = HEADER_LEN;
	switch (type) {
		case ServerType.hello: {
			// A sixth byte (caps) only comes back when this client sent caps.
			if (session !== 0 || (size !== 5 && size !== 6)) return null;
			const caps = size === 6 ? view.getUint8(p + 5) : null;
			return { type: "hello", version: view.getUint8(p), maxFrame: view.getUint32(p + 1), caps };
		}
		case ServerType.output: {
			if (session === 0 || size < 8) return null;
			const offset = getU64(view, p);
			if (offset === null) return null;
			return { type: "output", session, offset, data: buf.subarray(p + 8) };
		}
		case ServerType.snapshot:
		case ServerType.preview: {
			if (session === 0 || size < 13) return null;
			const offset = getU64(view, p);
			const cols = view.getUint16(p + 8);
			const rows = view.getUint16(p + 10);
			const alt = view.getUint8(p + 12);
			if (offset === null || !validDim(cols) || !validDim(rows) || alt > 1) return null;
			const kind = type === ServerType.snapshot ? "snapshot" : "preview";
			return { type: kind, session, offset, cols, rows, altScreen: alt === 1, vt: buf.subarray(p + 13) };
		}
		case ServerType.liveSnapshot: {
			if (session === 0 || size < 28) return null;
			const offset = getU64(view, p);
			const cols = view.getUint16(p + 8);
			const rows = view.getUint16(p + 10);
			const historyEnd = getU64(view, p + 16);
			const part = view.getUint8(p + 26);
			const parts = view.getUint8(p + 27);
			if (offset === null || historyEnd === null || !validDim(cols) || !validDim(rows) || part >= parts) return null;
			return {
				type: "liveSnapshot",
				session,
				offset,
				cols,
				rows,
				epoch: view.getUint32(p + 12),
				historyEnd,
				tailRows: view.getUint16(p + 24),
				part,
				parts,
				vt: buf.subarray(p + 28),
			};
		}
		case ServerType.history: {
			if (session === 0 || size < 19) return null;
			const firstRow = getU64(view, p + 6);
			const part = view.getUint8(p + 16);
			const parts = view.getUint8(p + 17);
			const atStart = view.getUint8(p + 18);
			if (firstRow === null || part >= parts || atStart > 1) return null;
			return {
				type: "history",
				session,
				reqId: view.getUint16(p),
				epoch: view.getUint32(p + 2),
				firstRow,
				rowCount: view.getUint16(p + 14),
				part,
				parts,
				atStart: atStart === 1,
				vt: buf.subarray(p + 19),
			};
		}
		case ServerType.historyError: {
			if (session === 0 || size !== 3) return null;
			return { type: "historyError", session, reqId: view.getUint16(p), code: view.getUint8(p + 2) };
		}
		case ServerType.exit: {
			if (session === 0 || size !== 5) return null;
			return { type: "exit", session, code: view.getInt32(p), signal: view.getUint8(p + 4) };
		}
		case ServerType.pong: {
			if (session !== 0 || size !== 8) return null;
			const micros = getU64(view, p);
			return micros === null ? null : { type: "pong", micros };
		}
		case ServerType.error: {
			if (size < 2) return null;
			return { type: "error", session, code: view.getUint16(p), message: utf8.decode(buf.subarray(p + 2)) };
		}
		default:
			return { type: "unknown", frameType: type };
	}
}
