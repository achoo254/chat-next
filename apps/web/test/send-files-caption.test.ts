// Where the caption of picked files goes: with the first send, or, in a chat
// that sends on to an app taking a caption only with a photo (Zalo), as its own
// message first when the first send is not a photo.
import type { AlbumItemInput, MediaInput, PendingMessage, SendAlbumOptions, SendMediaOptions, SendTextOptions } from "@achoo254/chat-core";
import { describe, expect, it } from "vitest";
import type { ChatSource } from "../src/messaging/data/source.ts";
import { sendFiles } from "../src/messaging/media/send-media.ts";

type Sent = { readonly what: "text" | "media" | "album"; readonly text: string; readonly replyToSeq: number };

/** The sends of a composer, in order. */
function recordingSource(): { source: Pick<ChatSource, "sendText" | "sendMedia" | "sendAlbum">; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		source: {
			sendText: (_chatId: number, text: string, options?: SendTextOptions): Promise<PendingMessage | null> => {
				sent.push({ what: "text", text, replyToSeq: options?.replyToSeq ?? 0 });
				return Promise.resolve(null);
			},
			sendMedia: (_chatId: number, _file: Blob, _media: MediaInput, options?: SendMediaOptions): Promise<PendingMessage | null> => {
				sent.push({ what: "media", text: options?.text ?? "", replyToSeq: options?.replyToSeq ?? 0 });
				return Promise.resolve(null);
			},
			sendAlbum: (_chatId: number, items: readonly AlbumItemInput[], options?: SendAlbumOptions): Promise<PendingMessage[]> => {
				sent.push({ what: "album", text: items[0]?.text ?? "", replyToSeq: options?.replyToSeq ?? 0 });
				return Promise.resolve([]);
			},
		},
	};
}

const limits = { uploadSizeMax: 1 << 20, albumSizeMax: 10 };
const pdf = () => new File([new Uint8Array(4)], "hop-dong.pdf", { type: "application/pdf" });
const jpeg = () => new File([new Uint8Array(4)], "anh.jpg", { type: "image/jpeg" });
const target = { chatId: 1, topicId: 0, replyToSeq: 9 };

describe("the caption of picked files", () => {
	it("goes with the first send", async () => {
		const { source, sent } = recordingSource();
		await sendFiles(source, target, [pdf()], "đọc nhé", limits);
		expect(sent).toEqual([{ what: "media", text: "đọc nhé", replyToSeq: 9 }]);
	});

	it("goes first as its own message, with the reply, when the app takes a caption only with a photo and the first send is a file", async () => {
		const { source, sent } = recordingSource();
		await sendFiles(source, target, [pdf()], "đọc nhé", limits, false, true);
		expect(sent).toEqual([
			{ what: "text", text: "đọc nhé", replyToSeq: 9 },
			{ what: "media", text: "", replyToSeq: 0 },
		]);
	});

	it("stays on a photo there", async () => {
		const { source, sent } = recordingSource();
		await sendFiles(source, target, [jpeg()], "ảnh đây", limits, false, true);
		expect(sent).toEqual([{ what: "media", text: "ảnh đây", replyToSeq: 9 }]);
	});

	it("sends no empty message when there is no caption", async () => {
		const { source, sent } = recordingSource();
		await sendFiles(source, target, [pdf()], "", limits, false, true);
		expect(sent).toEqual([{ what: "media", text: "", replyToSeq: 9 }]);
	});
});
