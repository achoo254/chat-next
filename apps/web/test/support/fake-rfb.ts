// A tiny VNC (RFB 3.8) server for the visual harness and tests: it greets,
// offers one security type (None, or Apple's ARD so the client asks for the
// Mac account), sends one Raw picture of a canvas in the pixel format the
// client asked for, and ignores input. Test and harness only.

export class FakeRfb {
	private inbox = new Uint8Array(0);
	private stage: "version" | "security" | "init" | "messages" = "version";
	private shifts = { r: 16, g: 8, b: 0 };
	private sent = false;

	constructor(
		private readonly security: 1 | 30,
		private readonly picture: { width: number; height: number; rgba: Uint8ClampedArray },
		private readonly out: (bytes: Uint8Array) => void,
	) {}

	start(): void {
		this.out(new TextEncoder().encode("RFB 003.008\n"));
	}

	receive(bytes: Uint8Array): void {
		const joined = new Uint8Array(this.inbox.length + bytes.length);
		joined.set(this.inbox);
		joined.set(bytes, this.inbox.length);
		this.inbox = joined;
		for (;;) {
			const used = this.step();
			if (used === 0) return;
			this.inbox = this.inbox.slice(used);
		}
	}

	/** Handles one message at the head of the inbox; the bytes it used, 0 to wait for more. */
	private step(): number {
		const b = this.inbox;
		switch (this.stage) {
			case "version":
				if (b.length < 12) return 0;
				this.stage = "security";
				this.out(new Uint8Array([1, this.security]));
				return 12;
			case "security":
				if (b.length < 1) return 0;
				// ARD stops here: the client asks the user for the Mac account first.
				if (this.security === 30) return b.length;
				this.stage = "init";
				this.out(new Uint8Array([0, 0, 0, 0]));
				return 1;
			case "init": {
				if (b.length < 1) return 0;
				this.stage = "messages";
				const name = new TextEncoder().encode("Mac mini");
				const init = new Uint8Array(24 + name.length);
				const v = new DataView(init.buffer);
				v.setUint16(0, this.picture.width);
				v.setUint16(2, this.picture.height);
				init.set([32, 24, 0, 1], 4);
				v.setUint16(8, 255);
				v.setUint16(10, 255);
				v.setUint16(12, 255);
				init.set([16, 8, 0], 14);
				v.setUint32(20, name.length);
				init.set(name, 24);
				this.out(init);
				return 1;
			}
			case "messages":
				return this.message(b);
		}
	}

	private message(b: Uint8Array): number {
		if (b.length < 1) return 0;
		const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
		switch (b[0]) {
			case 0: // SetPixelFormat
				if (b.length < 20) return 0;
				this.shifts = { r: b[14] ?? 16, g: b[15] ?? 8, b: b[16] ?? 0 };
				return 20;
			case 2: {
				// SetEncodings
				if (b.length < 4) return 0;
				const n = v.getUint16(2);
				return b.length < 4 + 4 * n ? 0 : 4 + 4 * n;
			}
			case 3: // FramebufferUpdateRequest
				if (b.length < 10) return 0;
				if (!this.sent) this.sendPicture();
				return 10;
			case 4: // KeyEvent
				return b.length < 8 ? 0 : 8;
			case 5: // PointerEvent
				return b.length < 6 ? 0 : 6;
			case 6: {
				// ClientCutText
				if (b.length < 8) return 0;
				const n = v.getUint32(4);
				return b.length < 8 + n ? 0 : 8 + n;
			}
			default:
				// Anything else (fences, extended messages): drop what came.
				return b.length;
		}
	}

	private sendPicture(): void {
		this.sent = true;
		const { width, height, rgba } = this.picture;
		const head = new Uint8Array(16);
		const h = new DataView(head.buffer);
		h.setUint16(2, 1);
		h.setUint16(8, width);
		h.setUint16(10, height);
		h.setInt32(12, 0);
		this.out(head);
		const pixels = new Uint8Array(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			const value = ((rgba[i * 4] ?? 0) << this.shifts.r) | ((rgba[i * 4 + 1] ?? 0) << this.shifts.g) | ((rgba[i * 4 + 2] ?? 0) << this.shifts.b);
			// Little-endian, as noVNC asks.
			pixels[i * 4] = value & 0xff;
			pixels[i * 4 + 1] = (value >>> 8) & 0xff;
			pixels[i * 4 + 2] = (value >>> 16) & 0xff;
			pixels[i * 4 + 3] = (value >>> 24) & 0xff;
		}
		for (let i = 0; i < pixels.length; i += 256 * 1024) this.out(pixels.subarray(i, i + 256 * 1024));
	}
}
