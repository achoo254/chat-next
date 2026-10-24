// Saving a message's file on the device. Photos are fetched through the
// media cache and saved under their name (a cross-origin link cannot name
// the download). Anything else opens the short-lived URL: the media host
// sends files with "Content-Disposition: attachment", so the browser
// downloads them without holding the whole file in memory, and plays
// video and audio in a tab.
import type { MediaRef } from "@achoo254/chat-core";
import type { ChatSource } from "../data/source.ts";

/** How long a saved photo's object URL lives (the browser has started the download by then). */
const REVOKE_AFTER_MS = 60_000;

function clickLink(href: string, download: string | null): void {
	const link = document.createElement("a");
	link.href = href;
	if (download !== null) link.download = download;
	else {
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	}
	document.body.append(link);
	link.click();
	link.remove();
}

/** A name for a file the sender did not name (photos taken in the app have none). */
export function downloadName(media: Pick<MediaRef, "fileName" | "kind" | "mimeType">, seq: number): string {
	if (media.fileName !== "") return media.fileName;
	const ext = media.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") ?? "";
	const base = media.kind === "photo" ? "anh" : media.kind === "video" ? "video" : "file";
	return ext === "" ? `${base}-${seq}` : `${base}-${seq}.${ext}`;
}

/**
 * Downloads the file of message (chatId, seq). Resolves false when the
 * message is gone (deleted for everyone, no longer visible).
 */
export async function downloadMedia(source: ChatSource, chatId: number, seq: number, media: MediaRef): Promise<boolean> {
	const request = { chatId, seq, fileId: media.fileId, kind: media.kind };
	if (media.kind === "photo") {
		const file = await source.mediaFile(request);
		if (file.status === "unavailable") return false;
		const url = URL.createObjectURL(file.blob);
		clickLink(url, downloadName(media, seq));
		setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
		return true;
	}
	const signed = await source.mediaUrl(request);
	if (signed === null) return false;
	clickLink(signed.url, null);
	return true;
}
