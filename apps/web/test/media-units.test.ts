// Pure helpers of the media screens: sizes and durations as people read
// them, file type labels, how a selection splits into sends, waveforms,
// fixed picture boxes, album rows of the message list and shared media.
import type { StoredMessage } from "@app/core";
import { describe, expect, it } from "vitest";
import { albumBox, mediaBox } from "../src/messaging/media/box.ts";
import {
	encodeWaveform,
	fileExt,
	formatBytes,
	formatDuration,
	formatProgress,
	percent,
	planSends,
	sendKind,
	waveformBars,
} from "../src/messaging/media/media-format.ts";
import { collectShared } from "../src/messaging/media/shared-media.tsx";
import { groupRows } from "../src/messaging/ui/message-list.tsx";
import type { WindowItem } from "../src/messaging/data/store.ts";

function file(name: string, size: number, type: string): File {
	return new File([new Uint8Array(size)], name, { type });
}

function message(seq: number, patch: Partial<StoredMessage> = {}): StoredMessage {
	return {
		chatId: 1, seq, fromId: 2, date: 1_760_000_000 + seq, text: "", entities: [], mediaKind: null, replyToSeq: 0, forward: null,
		editDate: 0, editVersion: 0, randomId: 0, groupedId: 0, viaBotId: 0, reactions: [], integrationLabel: "", buttons: [],
		action: null, topicId: 0, linkPreview: null, recalled: false, silent: false, stale: false, ...patch,
	};
}

const media = (kind: "photo" | "video" | "document", fileName = "") => ({
	fileId: `f${kind}${fileName}`, fileHash: "", kind, mimeType: "", size: 10, fileName, width: 0, height: 0, duration: 0,
	inlineThumb: new Uint8Array(), sizes: [], waveform: new Uint8Array(),
});

describe("media format", () => {
	it("writes sizes the Vietnamese way", () => {
		expect(formatBytes(2.4 * 2 ** 20, "vi")).toBe("2,4 MB");
		expect(formatBytes(310 * 2 ** 20, "vi")).toBe("310 MB");
		expect(formatBytes(4096, "vi")).toBe("4 KB");
		expect(formatBytes(1000, "vi")).toBe("1000 B");
		expect(formatBytes(2.4 * 2 ** 20, "en")).toBe("2.4 MB");
		expect(formatProgress(2.1 * 2 ** 20, 3.3 * 2 ** 20, "vi")).toBe("2,1 / 3,3 MB");
		expect(percent(64, 100)).toBe(64);
		expect(percent(5, 0)).toBe(0);
	});

	it("writes durations", () => {
		expect(formatDuration(27_000)).toBe("0:27");
		expect(formatDuration(134_000, true)).toBe("02:14");
		expect(formatDuration(3_723_000)).toBe("1:02:03");
	});

	it("labels files by extension", () => {
		expect(fileExt("bao-cao.pdf")).toBe("PDF");
		expect(fileExt("lich.xlsx")).toBe("XLSX");
		expect(fileExt("README")).toBe("FILE");
		expect(fileExt("archive.tar.gzipped")).toBe("FILE");
	});

	it("sends large or unknown images as files", () => {
		expect(sendKind(file("a.jpg", 10, "image/jpeg"))).toBe("photo");
		expect(sendKind(file("a.heic", 10, "image/heic"))).toBe("document");
		expect(sendKind({ type: "image/png", size: 21 * 2 ** 20 })).toBe("document");
		expect(sendKind(file("a.mp4", 10, "video/mp4"))).toBe("video");
		expect(sendKind(file("a.mp4", 10, "video/mp4"), true)).toBe("document");
	});

	it("splits a selection into albums and refuses files over the limit", () => {
		const photos = Array.from({ length: 12 }, (_, i) => file(`p${i}.png`, 10, "image/png"));
		const docs = [file("a.pdf", 10, "application/pdf"), file("b.zip", 10, "application/zip")];
		const big = file("big.mov", 2000, "video/quicktime");
		const empty = file("empty.txt", 0, "text/plain");
		const plan = planSends([...photos, ...docs, big, empty], { uploadSizeMax: 1000, albumSizeMax: 10 });
		expect(plan.groups.map((group) => group.length)).toEqual([10, 2, 2]);
		expect(plan.groups[2]?.every((item) => item.kind === "document")).toBe(true);
		expect(plan.refused.map((entry) => [entry.file.name, entry.problem])).toEqual([
			["big.mov", "too_large"],
			["empty.txt", "empty"],
		]);
	});

	it("draws and records waveforms", () => {
		expect(waveformBars(new Uint8Array(), 4)).toEqual([0.15, 0.15, 0.15, 0.15]);
		expect(waveformBars(Uint8Array.from([0, 255, 51, 102]), 2)).toEqual([1, 0.4]);
		const encoded = encodeWaveform([0.1, 0.5, 0.25, 0.5], 2);
		expect([...encoded]).toEqual([255, 255]);
		expect(encodeWaveform([]).length).toBe(0);
		expect(encodeWaveform(Array.from({ length: 1000 }, (_, i) => i / 1000)).length).toBe(100);
	});
});

describe("boxes", () => {
	it("fits pictures in a fixed box with their shape", () => {
		expect(mediaBox(1200, 900)).toEqual({ width: 300, height: 225 });
		expect(mediaBox(900, 1600)).toEqual({ width: 203, height: 360 });
		expect(mediaBox(0, 0)).toEqual({ width: 300, height: 225 });
		expect(mediaBox(4000, 100)).toEqual({ width: 300, height: 90 });
		expect(albumBox(2)).toEqual({ width: 300, height: 150 });
		expect(albumBox(4)).toEqual({ width: 300, height: 300 });
		expect(albumBox(7)).toEqual({ width: 300, height: 300 });
	});
});

describe("album rows", () => {
	it("puts consecutive messages of one album in one row", () => {
		const items = new Map<string, WindowItem>([
			["s1", { kind: "message", message: message(1) }],
			["s2", { kind: "message", message: message(2, { groupedId: 9 }) }],
			["s3", { kind: "message", message: message(3, { groupedId: 9 }) }],
			["s4", { kind: "message", message: message(4, { groupedId: 9, recalled: true }) }],
			["s5", { kind: "message", message: message(5, { groupedId: 9, fromId: 3 }) }],
		]);
		const rows = groupRows([...items.keys()], (key) => items.get(key));
		expect(rows.map((row) => row.keys)).toEqual([["s1"], ["s2", "s3"], ["s4"], ["s5"]]);
	});
});

describe("shared media", () => {
	it("collects photos, files and links, newest first, links once", () => {
		const url = "https://wiki.hoandat.com/van-hanh";
		const shared = collectShared([
			message(1, { media: media("photo"), mediaKind: "photo" }),
			message(2, { media: media("document", "a.pdf"), mediaKind: "document" }),
			message(3, { text: `xem ${url}`, entities: [{ type: "url", offset: 4, length: url.length }] }),
			message(4, { text: url, linkPreview: { url, siteName: "wiki", title: "Wiki vận hành", description: "" } }),
			message(5, { media: media("video"), mediaKind: "video" }),
			message(6, { media: media("photo"), mediaKind: "photo", recalled: true }),
		]);
		expect(shared.photos.map((m) => m.seq)).toEqual([5, 1]);
		expect(shared.files.map((m) => m.seq)).toEqual([2]);
		expect(shared.links).toEqual([{ url, title: "Wiki vận hành", host: "wiki.hoandat.com", seq: 4, fromId: 2 }]);
	});
});
