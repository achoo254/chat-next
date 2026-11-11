// Terminal frames (docs/terminal-wire.md section 3): what this page sends
// decodes as the terminal process reads it, what the terminal process sends
// decodes here, and malformed frames decode to null without throwing.
import { describe, expect, it } from "vitest";
import {
	MAX_FRAME,
	MAX_INPUT,
	decodeServerFrame,
	encodeAck,
	encodeAttach,
	encodeDetach,
	encodeHello,
	encodeInput,
	encodePing,
	encodeResize,
} from "../../src/terminal/terminal-wire.ts";
import { decodeClientFrame, serverFrames } from "./fake-terminal.ts";

const text = (s: string) => new TextEncoder().encode(s);
const BIG = 2 ** 40 + 7;

describe("client frames", () => {
	it("encode big-endian, as the terminal process reads them", () => {
		expect([...encodeHello()]).toEqual([0x01, 0, 0, 0, 0, 1, 0]);
		expect([...encodeDetach(0x01020304)]).toEqual([0x13, 1, 2, 3, 4]);
		expect([...encodeResize(7, 300, 2)]).toEqual([0x11, 0, 0, 0, 7, 0x01, 0x2c, 0, 2]);
		expect(decodeClientFrame(encodeHello())).toEqual({ type: "hello", version: 1, caps: 0 });
		const input = decodeClientFrame(encodeInput(9, text("héllo")));
		expect(input).toMatchObject({ type: "input", session: 9 });
		expect(input?.type === "input" && [...input.data]).toEqual([...text("héllo")]);
		expect(decodeClientFrame(encodeAttach(9, BIG))).toEqual({ type: "attach", session: 9, lastOffset: BIG });
		expect(decodeClientFrame(encodeAck(9, 16_384))).toEqual({ type: "ack", session: 9, offset: 16_384 });
		expect(decodeClientFrame(encodePing(BIG))).toEqual({ type: "ping", micros: BIG });
		expect(decodeClientFrame(encodeResize(1, 1000, 1))).toEqual({ type: "resize", session: 1, cols: 1000, rows: 1 });
	});

	it("refuse what the terminal process would call malformed", () => {
		expect(() => encodeInput(1, new Uint8Array(MAX_INPUT + 1))).toThrow(RangeError);
		expect(encodeInput(1, new Uint8Array(MAX_INPUT)).length).toBe(MAX_INPUT + 5);
		expect(() => encodeResize(1, 0, 24)).toThrow(RangeError);
		expect(() => encodeResize(1, 80, 1001)).toThrow(RangeError);
		expect(() => encodeAttach(1, -1)).toThrow(RangeError);
		expect(() => encodeAttach(1, 2 ** 53)).toThrow(RangeError);
		expect(() => encodeDetach(2 ** 32)).toThrow(RangeError);
	});
});

describe("frames from the terminal process", () => {
	it("decode every type", () => {
		expect(decodeServerFrame(serverFrames.hello(1, 65_536))).toEqual({ type: "hello", version: 1, maxFrame: 65_536 });
		const out = decodeServerFrame(serverFrames.output(3, BIG, text("ok")));
		expect(out).toMatchObject({ type: "output", session: 3, offset: BIG });
		expect(out?.type === "output" && [...out.data]).toEqual([...text("ok")]);
		const snap = decodeServerFrame(serverFrames.snapshot(3, 10, 120, 40, true, text("\x1bc")));
		expect(snap).toMatchObject({ type: "snapshot", session: 3, offset: 10, cols: 120, rows: 40, altScreen: true });
		expect(snap?.type === "snapshot" && [...snap.vt]).toEqual([0x1b, 0x63]);
		expect(decodeServerFrame(serverFrames.exit(3, -1, 9))).toEqual({ type: "exit", session: 3, code: -1, signal: 9 });
		expect(decodeServerFrame(serverFrames.pong(BIG))).toEqual({ type: "pong", micros: BIG });
		expect(decodeServerFrame(serverFrames.error(0, 6, "đã thu hồi"))).toEqual({ type: "error", session: 0, code: 6, message: "đã thu hồi" });
		// Output with no bytes is still a frame.
		expect(decodeServerFrame(serverFrames.output(3, 5, new Uint8Array()))).toMatchObject({ type: "output", offset: 5 });
	});

	it("decode a frame inside a larger buffer (a data channel message view)", () => {
		const frame = serverFrames.output(2, 7, text("abc"));
		const padded = new Uint8Array(frame.length + 6);
		padded.set(frame, 3);
		expect(decodeServerFrame(padded.subarray(3, 3 + frame.length))).toMatchObject({ type: "output", session: 2, offset: 7 });
	});

	it("ignore unknown types and turn malformed frames into null, never throwing", () => {
		expect(decodeServerFrame(new Uint8Array([0x7a, 0, 0, 0, 1, 9, 9]))).toEqual({ type: "unknown", frameType: 0x7a });
		const bad: Uint8Array[] = [
			new Uint8Array(),
			new Uint8Array([0x90, 0, 0]),
			// Session 0 on a session frame, a session on Hello and Pong.
			serverFrames.output(0, 1, text("x")),
			(() => {
				const f = serverFrames.hello();
				f[4] = 1;
				return f;
			})(),
			(() => {
				const f = serverFrames.pong(1);
				f[4] = 1;
				return f;
			})(),
			// Too short for its type, or the wrong fixed size.
			serverFrames.hello().subarray(0, 9),
			serverFrames.exit(1, 0, 0).subarray(0, 8),
			new Uint8Array([...serverFrames.pong(1), 0]),
			serverFrames.output(1, 1, new Uint8Array()).subarray(0, 12),
			serverFrames.snapshot(1, 0, 80, 24, false, new Uint8Array()).subarray(0, 17),
			new Uint8Array([0x9f, 0, 0, 0, 0, 1]),
			// Values out of range: size 0, size over 1000, altScreen 2, an offset past 2^53.
			serverFrames.snapshot(1, 0, 0, 24, false, new Uint8Array()),
			serverFrames.snapshot(1, 0, 80, 1001, false, new Uint8Array()),
			(() => {
				const f = serverFrames.snapshot(1, 0, 80, 24, false, new Uint8Array());
				f[17] = 2;
				return f;
			})(),
			(() => {
				const f = serverFrames.output(1, 0, new Uint8Array());
				f[5] = 0xff;
				return f;
			})(),
			// Over the largest frame.
			new Uint8Array(MAX_FRAME + 1).fill(0x90, 0, 1),
		];
		for (const frame of bad) expect(decodeServerFrame(frame)).toBeNull();
		// Random bytes never throw.
		for (let i = 0; i < 500; i++) {
			const junk = new Uint8Array(Math.floor(Math.random() * 40));
			crypto.getRandomValues(junk);
			expect(() => decodeServerFrame(junk)).not.toThrow();
		}
		// A message that is not UTF-8 decodes with replacement characters.
		expect(decodeServerFrame(new Uint8Array([0x9f, 0, 0, 0, 0, 0, 3, 0xff, 0xfe]))).toMatchObject({ type: "error", code: 3 });
	});
});
