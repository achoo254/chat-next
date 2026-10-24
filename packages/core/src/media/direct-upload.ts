// A small file uploaded right away, outside the message outbox: a profile
// photo the user just cropped. One CreateUpload, its parts PUT in order and
// CompleteUpload; a failure throws (the user tries again), nothing resumes.
import { Code, ConnectError } from "@connectrpc/connect";
import type { Http } from "@achoo254/chat-platform";
import type { RemoteApi } from "../protocol/api.ts";
import { toWireMediaKind } from "../protocol/map.ts";
import { sha256Blob } from "./sha256.ts";

/** Uploads a photo and returns its file_id (the server's own copy when it already has these bytes from the user). */
export async function uploadPhotoNow(api: NonNullable<RemoteApi["media"]>, http: Http, file: Blob, fileName: string): Promise<string> {
	const created = await api.createUpload({
		kind: toWireMediaKind("photo"),
		fileName,
		mimeType: file.type,
		size: BigInt(file.size),
		fileHash: await sha256Blob(file),
	});
	const result = created.result;
	if (result.case === "existing") return result.value.fileId;
	if (result.case !== "upload") throw new ConnectError("CreateUpload returned nothing", Code.Internal);
	const session = result.value;
	const partSize = Number(session.partSize);
	const parts: { partNumber: number; etag: string }[] = [];
	for (const part of [...session.parts].sort((a, b) => a.partNumber - b.partNumber)) {
		const start = (part.partNumber - 1) * partSize;
		const response = await http.put(part.url, file.slice(start, start + partSize));
		if (response.status < 200 || response.status >= 300 || response.etag === "") {
			throw new ConnectError(`photo upload failed (HTTP ${response.status})`, Code.Unavailable);
		}
		parts.push({ partNumber: part.partNumber, etag: response.etag });
	}
	const done = await api.completeUpload({ uploadId: session.uploadId, parts });
	if (done.media === undefined) throw new ConnectError("CompleteUpload returned no media", Code.Internal);
	return done.media.fileId;
}
