// The uploads named by one message, made ready for the AI: an image (by its
// bytes) goes to an AI that takes images as an image and is kept with the
// thread for showing it again; any other file is saved in the session's
// folder and the AI is told where.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ImageInput } from "../providers/types.ts";
import { imageType } from "./image-type.ts";
import { saveInFolder } from "./project-files.ts";
import type { Upload } from "./uploads.ts";

/** One attachment as the journal keeps it (Attachment in the protocol). */
export type SentAttachment = { id: string; name: string; mimeType: string; size: number; image: boolean; path: string };

export type PreparedMessage = { attachments: SentAttachment[]; images: ImageInput[]; files: { path: string; size: number }[] };

export type PrepareOptions = {
  /** The session's working directory. */
  cwd: string;
  /** Where the thread keeps the images it sent. */
  keepDir: string;
  /** The AI takes images. */
  images: boolean;
  imageMaxBytes: number;
  isSensitive: (p: string) => boolean;
  now?: Date;
};

/** The file an image of a thread is kept in. */
export function keptImage(keepDir: string, id: string): string {
  return join(keepDir, id);
}

/**
 * Places every upload; on a failure, what it placed so far is removed again
 * and the error goes on. The uploads' own bytes are left to the caller.
 */
export function prepareAttachments(uploads: readonly Upload[], opts: PrepareOptions): PreparedMessage {
  const placed: string[] = [];
  const out: PreparedMessage = { attachments: [], images: [], files: [] };
  try {
    for (const u of uploads) {
      const bytes = opts.images && u.size <= opts.imageMaxBytes ? readFileSync(u.file) : undefined;
      const type = bytes ? imageType(bytes.subarray(0, 16)) : undefined;
      if (bytes && type) {
        mkdirSync(opts.keepDir, { recursive: true, mode: 0o700 });
        const kept = keptImage(opts.keepDir, u.id);
        copyFileSync(u.file, kept);
        placed.push(kept);
        out.images.push({ mediaType: type, data: new Uint8Array(bytes) });
        out.attachments.push({ id: u.id, name: u.name, mimeType: type, size: u.size, image: true, path: "" });
        continue;
      }
      const path = saveInFolder(opts.cwd, u.file, u.name, { isSensitive: opts.isSensitive, ...(opts.now ? { now: opts.now } : {}) });
      placed.push(resolve(opts.cwd, path));
      out.files.push({ path, size: u.size });
      out.attachments.push({ id: u.id, name: u.name, mimeType: u.mimeType, size: u.size, image: false, path });
    }
  } catch (err) {
    for (const p of placed) rmSync(p, { force: true });
    throw err;
  }
  return out;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The message the AI reads: the user's text, then where the files they sent are. */
export function textForAi(text: string, files: readonly { path: string; size: number }[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f.path} (${sizeText(f.size)})`).join("\n");
  const note = `The user attached ${files.length === 1 ? "this file" : "these files"}, saved in the working directory:\n${list}`;
  return text.trim() === "" ? note : `${text}\n\n${note}`;
}
