// Animated stickers (.tgs): how one is recognised and how its Lottie document is read.
import { Blob as NodeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readLottie } from "../src/messaging/media/animated-sticker.tsx";
import { isAnimatedSticker } from "../src/messaging/media/media-format.ts";

describe("isAnimatedSticker", () => {
	it("is a document named *.tgs, whatever the case", () => {
		expect(isAnimatedSticker({ kind: "document", fileName: "sticker.tgs" })).toBe(true);
		expect(isAnimatedSticker({ kind: "document", fileName: "AnimatedSticker.TGS" })).toBe(true);
	});
	it("is not another file or another kind", () => {
		expect(isAnimatedSticker({ kind: "document", fileName: "report.pdf" })).toBe(false);
		expect(isAnimatedSticker({ kind: "photo", fileName: "sticker.tgs" })).toBe(false);
	});
});

// The test page (jsdom) has no Blob.stream(), which every browser has: Node's Blob stands in.
function blobOf(...parts: BlobPart[]): Blob {
	return new NodeBlob(parts as ConstructorParameters<typeof NodeBlob>[0]) as unknown as Blob;
}

describe("readLottie", () => {
	const animation = { v: "5.5.2", fr: 60, ip: 0, op: 60, w: 512, h: 512, layers: [] };

	it("unpacks the gzipped JSON", async () => {
		const blob = blobOf(new Uint8Array(gzipSync(JSON.stringify(animation))));
		await expect(readLottie(blob)).resolves.toEqual(animation);
	});
	it("refuses what is not gzip", async () => {
		await expect(readLottie(blobOf("not a sticker"))).rejects.toThrow();
	});
	it("refuses a file far bigger than any sticker", async () => {
		await expect(readLottie(blobOf(new Uint8Array((1 << 20) + 1)))).rejects.toThrow("too large");
	});
	it("refuses a small file that unpacks huge", async () => {
		const bomb = gzipSync(Buffer.alloc(9 << 20, 32));
		expect(bomb.byteLength).toBeLessThan(1 << 20);
		await expect(readLottie(blobOf(new Uint8Array(bomb)))).rejects.toThrow("unpacks too large");
	});
});
