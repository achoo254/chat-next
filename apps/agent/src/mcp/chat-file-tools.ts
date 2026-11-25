/**
 * `chat_send_file`: files of the session's folder sent to a chat as the
 * user. A write of tunelo's MCP, so the user approves the call (its card
 * lists the files, describeFiles) before this runs; nothing is read for
 * upload before then. The approval holds for the files as the card showed
 * them (size, modification time, SHA-256): one changed since is refused.
 *
 * Each path must resolve (links followed) to a regular file inside the
 * session's folder (its `.tunelo-attachments/` included) and outside the
 * sensitive folders. The bytes go to Chat's media host the way the app
 * sends them: start_media_upload (an internal tool of Chat's server, never
 * listed to an agent), a PUT of each part to its signed URL, then
 * complete_media_upload; send_media posts the media ids, one message or an
 * album. No byte, URL or token is logged or returned.
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WriteFile } from "../providers/types.ts";
import type { ToolRegistrar } from "./groups.js";
import { failure } from "./mcp-result.js";

/** What `send_file` needs of the session it runs for. */
export interface ChatFileSession {
	/** The session's working folder; undefined once its thread is gone. */
	dir(): string | undefined;
	isSensitive(path: string): boolean;
	/** A tool of Chat's server an agent may call too (get_chat, send_media); its answer is redacted. */
	callApp(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
	/** An internal upload tool of Chat's server (start_media_upload, complete_media_upload). */
	callInternal(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
	/**
	 * The files of this exact call as its approval card showed them; undefined
	 * when it ran without a card (the AI's bypass mode, where none is asked).
	 */
	approvedFiles?(args: Record<string, unknown>): FileStamp[] | undefined;
	/** Sends the parts; the global fetch when unset (tests). */
	fetch?: typeof fetch;
}

/** A file as an approval card showed it: what must still hold when it is uploaded. */
export type FileStamp = { path: string; size: number; mtimeMs: number; sha256: string };

export const SEND_FILE_MAX = 10;
/** A photo at most this big rides on the approval card whole, as its preview. */
export const PREVIEW_MAX_BYTES = 256 * 1024;
/** How long one part's PUT may take. */
const PART_TIMEOUT_MS = 120_000;
/** Fresh part URLs are asked for when these are this close to expiring. */
const URL_MARGIN_MS = 30_000;
/** Larger images go as files (the server takes photos up to 20 MiB), as in the app. */
const PHOTO_MAX_BYTES = 20 * 2 ** 20;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const BY_EXTENSION: Readonly<Record<string, string>> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".zip": "application/zip",
};

export type SendKind = "photo" | "video" | "document";
export type SendableFile = { path: string; name: string; size: number; mtimeMs: number; mime: string; kind: SendKind };
export type FileCheck = { ok: true; file: SendableFile } | { ok: false; name: string; problem: string };

/** The file `path` names, if the session may send it from `dir`; else why not. */
export function checkFile(dir: string, path: string, isSensitive: (path: string) => boolean): FileCheck {
	const name = basename(path);
	if (path.split(/[\\/]/).includes("..")) return { ok: false, name, problem: "a path with .. is not allowed" };
	let root: string;
	try {
		root = realpathSync(dir);
	} catch {
		return { ok: false, name, problem: "the session's folder is gone" };
	}
	let real: string;
	try {
		real = realpathSync(isAbsolute(path) ? path : join(root, path));
	} catch {
		return { ok: false, name, problem: "not found" };
	}
	if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) return { ok: false, name, problem: "outside the session's folder" };
	if (isSensitive(real)) return { ok: false, name, problem: "in a sensitive folder" };
	const st = statSync(real);
	if (!st.isFile()) return { ok: false, name, problem: "not a regular file" };
	const mime = mimeOf(real);
	const kind: SendKind = PHOTO_TYPES.has(mime) && st.size <= PHOTO_MAX_BYTES ? "photo" : VIDEO_TYPES.has(mime) ? "video" : "document";
	return { ok: true, file: { path: real, name: basename(real), size: st.size, mtimeMs: st.mtimeMs, mime, kind } };
}

/** The type of a file from its first bytes, else its name. */
function mimeOf(path: string): string {
	const head = Buffer.alloc(16);
	let read = 0;
	try {
		const fd = openSync(path, "r");
		try {
			read = readSync(fd, head, 0, head.length, 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Unreadable here: the name decides, and the upload says why it fails.
	}
	const at = (offset: number, text: string) => head.subarray(offset, offset + text.length).toString("latin1") === text;
	if (read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (read >= 8 && at(0, "\x89PNG\r\n\x1a\n")) return "image/png";
	if (read >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "image/gif";
	if (read >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
	if (read >= 12 && at(4, "ftyp")) return at(8, "qt  ") ? "video/quicktime" : "video/mp4";
	if (read >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
	if (read >= 5 && at(0, "%PDF-")) return "application/pdf";
	return BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The files of a `send_file` call as its approval card lists them (a small
 * photo whole, as its preview), and the stamps of those that can be sent,
 * which the upload must still match.
 */
export async function describeFiles(
	dir: string | undefined,
	paths: readonly string[],
	isSensitive: (path: string) => boolean,
): Promise<{ files: WriteFile[]; stamps: FileStamp[] }> {
	const files: WriteFile[] = [];
	const stamps: FileStamp[] = [];
	for (const path of paths) {
		if (dir === undefined) {
			files.push({ name: basename(path), size: 0n, mime: "", problem: "the session's folder is gone" });
			continue;
		}
		const check = checkFile(dir, path, isSensitive);
		if (!check.ok) {
			files.push({ name: check.name, size: 0n, mime: "", problem: check.problem });
			continue;
		}
		const { file } = check;
		const preview = file.kind === "photo" && file.size <= PREVIEW_MAX_BYTES ? readPreview(file.path) : undefined;
		files.push({ name: file.name, size: BigInt(file.size), mime: file.mime, ...(preview ? { preview } : {}) });
		stamps.push({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, sha256: await sha256(file.path) });
	}
	return { files, stamps };
}

function readPreview(path: string): Uint8Array | undefined {
	try {
		return new Uint8Array(readFileSync(path));
	} catch {
		return undefined;
	}
}

const sendFileSchema = z.object({
	chat_id: z.number().int().describe("The chat to post in"),
	paths: z
		.array(z.string().min(1))
		.min(1)
		.max(SEND_FILE_MAX)
		.describe("Files to send, relative to the session's working folder (or absolute inside it, .tunelo-attachments/ included); 2 or more go as an album where Chat allows"),
	caption: z.string().optional().describe("Text under the files (under the first one of an album)"),
	reply_to_seq: z.number().int().optional().describe("seq of the message this replies to"),
});
type SendFileArgs = z.infer<typeof sendFileSchema>;

/** Registers `send_file` (`chat_send_file` as clients see it); without `session` it is only listed. */
export function registerChatFileTools(tools: ToolRegistrar, session: ChatFileSession | undefined): void {
	tools.registerTool(
		"send_file",
		{
			title: "Send files to a chat",
			description:
				"Send files of this session's working folder (photos, videos, any file) to a chat as the user: one file posts one message, several an album. The user approves each call on their device first. Files outside the working folder are refused.",
			inputSchema: sendFileSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (args) => (session ? sendFiles(args, session) : failure(new Error("chat_send_file works only in a session tunelo opened"))),
	);
}

const HIDDEN = "chat_hidden_from_ai: the user hid this chat from AI; only the user can change that, in the app. Nothing was sent.";
const READ_ONLY =
	"imported_chat_read_only: this chat cannot be sent to from Chat (a copy of a chat in another app, or its account is disconnected). Nothing was sent.";
const COMPOSER_ONLY =
	"imported_chat_composer_only: this app only takes what the user sends themselves, so no tool can send here. Do not try another way: hand the text or the file to the user instead (put the text into the chat's composer, or ask the user to attach the file themselves). " +
	"Zalo chỉ nhận tin do chính người dùng gửi: đưa nội dung vào ô soạn tin / nhờ người dùng tự đính kèm.";

/** A server's refusal, said so the model knows what to do next. */
export function explainChatError(message: string): string {
	if (message.includes("chat_hidden_from_ai")) return HIDDEN;
	if (message.includes("imported_chat_composer_only")) return COMPOSER_ONLY;
	if (message.includes("imported_chat_read_only")) return READ_ONLY;
	return message;
}

/** The text of a tool's answer. */
function textOf(result: CallToolResult): string {
	return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/** What a failed call says: the server's {"error":{"message"}}, or its text. */
function errorOf(result: CallToolResult): string {
	const text = textOf(result);
	try {
		const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
		if (typeof parsed.error?.message === "string") return parsed.error.message;
	} catch {
		// Not JSON: the text says it.
	}
	return text || "the call failed";
}

/** A JSON object answer, or an error with what the server said. */
function answerOf(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error(explainChatError(errorOf(result)));
	const parsed: unknown = JSON.parse(textOf(result));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Chat answered something unexpected");
	return parsed as Record<string, unknown>;
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** protojson writes int64 as a string. */
const int = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number.NaN);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function sendFiles(args: SendFileArgs, session: ChatFileSession): Promise<CallToolResult> {
	const dir = session.dir();
	if (dir === undefined) return failure(new Error("The session's folder is gone; nothing was sent."));
	const files: SendableFile[] = [];
	const refused: string[] = [];
	for (const path of args.paths) {
		const check = checkFile(dir, path, (p) => session.isSensitive(p));
		if (check.ok) files.push(check.file);
		else refused.push(`${path}: ${check.problem}`);
	}
	if (refused.length > 0) return failure(new Error(`Nothing was sent; these files cannot be sent:\n${refused.join("\n")}`));
	const hashes = new Map<SendableFile, string>();
	for (const file of files) hashes.set(file, await sha256(file.path));
	const changed = changedSinceApproval(files, hashes, session.approvedFiles?.(args));
	if (changed) return failure(new Error(changed));

	const lines: string[] = [];
	try {
		// A chat the files cannot go to is refused before any upload.
		answerOf(await session.callApp("get_chat", { chat_id: args.chat_id }));
		const ids = new Map<SendableFile, string>();
		for (const file of files) {
			const { id, existed } = await upload(file, hashes.get(file) ?? "", session);
			ids.set(file, id);
			lines.push(`${file.name}: ${existed ? "already in Chat" : `uploaded (${file.size} bytes)`}`);
		}
		// Chat takes photos and videos together in an album, other files in another.
		const visual = files.filter((f) => f.kind !== "document");
		const documents = files.filter((f) => f.kind === "document");
		const sends = [visual, documents].filter((group) => group.length > 0);
		for (const [i, group] of sends.entries()) {
			const first = i === 0;
			const answer = await session.callApp("send_media", {
				chat_id: args.chat_id,
				media_ids: group.map((f) => ids.get(f) ?? ""),
				...(first && args.caption ? { caption: args.caption } : {}),
				...(first && args.reply_to_seq ? { reply_to_seq: args.reply_to_seq } : {}),
			});
			answerOf(answer);
			lines.push(`Sent ${group.length === 1 ? "1 file" : `an album of ${group.length}`}: ${textOf(answer)}`);
		}
		return { content: [{ type: "text", text: lines.join("\n") }] };
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return failure(new Error([...lines, why].join("\n")));
	}
}

/** Why the files are not those the user approved (another file, or one changed since); undefined when they are, or no card was asked. */
function changedSinceApproval(files: readonly SendableFile[], hashes: ReadonlyMap<SendableFile, string>, approved: readonly FileStamp[] | undefined): string | undefined {
	if (approved === undefined) return undefined;
	const again = "Nothing was sent: call chat_send_file again so the user approves the files as they are now.";
	if (approved.length !== files.length) return `The files are not those the user approved. ${again}`;
	for (const [i, file] of files.entries()) {
		const seen = approved[i];
		if (!seen || seen.path !== file.path) return `${file.name} is not the file the user approved. ${again}`;
		if (seen.size !== file.size || seen.mtimeMs !== file.mtimeMs || seen.sha256 !== hashes.get(file)) {
			return `${file.name} changed after the user approved it. ${again}`;
		}
	}
	return undefined;
}

/** Uploads one file (its SHA-256 `hash`), or finds it already stored: its media id. */
async function upload(file: SendableFile, hash: string, session: ChatFileSession): Promise<{ id: string; existed: boolean }> {
	const started = answerOf(
		await session.callInternal("start_media_upload", { kind: file.kind, file_name: file.name, mime_type: file.mime, size: file.size, file_hash: hash }),
	);
	const existing = record(started.existing);
	if (existing) {
		const id = str(existing.file_id);
		if (!id) throw new Error(`${file.name}: Chat named no stored file`);
		return { id, existed: true };
	}
	let current = record(started.upload);
	if (!current) throw new Error(`${file.name}: Chat started no upload`);
	const uploadId = str(current.upload_id);
	const partSize = int(current.part_size);
	if (!uploadId || !(partSize > 0)) throw new Error(`${file.name}: Chat started no usable upload`);
	const done = new Map<number, string>();
	for (const p of Array.isArray(current.completed_parts) ? current.completed_parts : []) {
		const part = record(p);
		if (part) done.set(int(part.part_number), str(part.etag));
	}
	const total = Math.max(1, Math.ceil(file.size / partSize));
	const handle = await open(file.path, "r");
	try {
		for (let n = 1; n <= total; n++) {
			if (done.has(n)) continue;
			// URLs about to expire: fresh ones for the parts left.
			const expires = int(current.urls_expire_at) * 1000;
			if (Number.isFinite(expires) && expires - URL_MARGIN_MS < Date.now()) {
				current = record(answerOf(await session.callInternal("start_media_upload", { upload_id: uploadId })).upload) ?? current;
			}
			const url = urlOf(current, n);
			if (!url) throw new Error(`${file.name}: Chat gave no URL for part ${n}`);
			const length = Math.min(partSize, file.size - (n - 1) * partSize);
			const bytes = Buffer.alloc(length);
			await handle.read(bytes, 0, length, (n - 1) * partSize);
			done.set(n, await putPart(session.fetch ?? fetch, url, bytes, `${file.name}: part ${n} of ${total}`));
		}
	} finally {
		await handle.close();
	}
	const parts = [...done].sort(([a], [b]) => a - b).map(([part_number, etag]) => ({ part_number, etag }));
	const completed = answerOf(await session.callInternal("complete_media_upload", { upload_id: uploadId, parts }));
	const id = str(record(completed.media)?.file_id);
	if (!id) throw new Error(`${file.name}: Chat stored no file`);
	return { id, existed: false };
}

function urlOf(upload: Record<string, unknown>, n: number): string | undefined {
	for (const p of Array.isArray(upload.parts) ? upload.parts : []) {
		const part = record(p);
		if (part && int(part.part_number) === n) return str(part.url) || undefined;
	}
	return undefined;
}

/** PUTs one part (no auth header: the token is in the URL, which never shows up in an error); its ETag. */
async function putPart(send: typeof fetch, url: string, bytes: Buffer, what: string): Promise<string> {
	let response: Response;
	try {
		response = await send(url, { method: "PUT", body: new Uint8Array(bytes), signal: AbortSignal.timeout(PART_TIMEOUT_MS) });
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		// No cause on purpose: fetch's error may quote the signed URL, whose token must not travel further.
		// eslint-disable-next-line preserve-caught-error
		throw new Error(`${what}: ${timedOut ? "the upload timed out" : "the media host could not be reached"}`);
	}
	if (!response.ok) throw new Error(`${what}: the media host answered ${response.status}`);
	const etag = response.headers.get("etag");
	if (!etag) throw new Error(`${what}: the media host gave no ETag`);
	return etag;
}

function sha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}
