// Files a device sends with a message arrive here first, in pieces, end-to-end
// encrypted like every frame. Each upload is a file under tunelo's own data
// folder until the message that names it goes (ThreadSend.attachment_ids);
// one never sent is dropped after an hour. Nothing here touches the
// session's folder: that happens only when the message goes.
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";

const MIB = 1024 * 1024;

/** What a machine takes (AttachmentLimits in the protocol). */
export const ATTACHMENT_LIMITS = {
  fileMaxBytes: 25 * MIB,
  messageMaxBytes: 50 * MIB,
  messageMaxFiles: 10,
  // Claude takes images up to 5 MB base64-encoded: 3.75 MiB of bytes.
  imageMaxBytes: (15 * MIB) / 4,
  pieceMaxBytes: 512 * 1024,
} as const;

export type AttachmentLimits = { [K in keyof typeof ATTACHMENT_LIMITS]: number };

/** Unsent uploads kept at once, in count and in bytes, across every device. */
const WAITING_MAX = 40;
const WAITING_MAX_BYTES = 200 * MIB;
const KEEP_MS = 60 * 60_000;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_MAX = 1024;
const MIME_MAX = 255;

/** A refusal about an attachment, worded by devices from `reason` (+ `subject`). */
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly reason: ErrorReason,
    readonly subject = "",
  ) {
    super(message);
  }
}

/** One upload: whole once `received` reaches `size`. */
export type Upload = {
  id: string;
  threadId: string;
  /** As the device named it; made safe only where it is saved. */
  name: string;
  mimeType: string;
  size: number;
  received: number;
  /** Where its bytes are, inside tunelo's data folder. */
  file: string;
  createdAt: number;
};

export type UploadPiece = {
  uploadId: string;
  threadId: string;
  name: string;
  mimeType: string;
  size: number;
  offset: number;
  data: Uint8Array;
};

export class Uploads {
  private readonly waiting = new Map<string, Upload>();
  private readonly now: () => number;
  readonly limits: AttachmentLimits;

  constructor(
    private readonly dir: string,
    opts: { now?: () => number; limits?: Partial<AttachmentLimits> } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.limits = { ...ATTACHMENT_LIMITS, ...opts.limits };
    // What a previous run left is unreachable now: no device holds its ids.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Takes one piece. The first (offset 0) opens the upload for `threadId`
   * (the caller checked the thread exists); the others continue it in order.
   * Any refusal drops the upload.
   */
  put(p: UploadPiece): void {
    this.sweep();
    if (!UPLOAD_ID.test(p.uploadId)) throw new AttachmentError("bad upload id", ErrorReason.ATTACHMENT_NOT_FOUND);
    if (p.data.length > this.limits.pieceMaxBytes) {
      this.drop(p.uploadId);
      throw new AttachmentError(`a piece is larger than ${this.limits.pieceMaxBytes} bytes`, ErrorReason.ATTACHMENT_TOO_LARGE);
    }
    let u = this.waiting.get(p.uploadId);
    if (p.offset === 0 && !u) u = this.open(p);
    if (!u || u.received !== p.offset || u.received + p.data.length > u.size || (p.data.length === 0 && u.size > 0)) {
      this.drop(p.uploadId);
      throw new AttachmentError("no upload continues there", ErrorReason.ATTACHMENT_NOT_FOUND);
    }
    if (p.data.length === 0) return;
    let fd: number | undefined;
    try {
      fd = openSync(u.file, "a", 0o600);
      writeSync(fd, p.data);
    } catch (err) {
      this.drop(u.id);
      throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    u.received += p.data.length;
  }

  cancel(uploadId: string): void {
    this.drop(uploadId);
  }

  /**
   * The whole uploads `ids` of `threadId`, in order, within a message's
   * limits; they leave the waiting list (the caller deletes their files with
   * `discard` once used). Nothing is taken when one is missing.
   */
  take(threadId: string, ids: readonly string[]): Upload[] {
    this.sweep();
    if (new Set(ids).size !== ids.length) throw new AttachmentError("an upload is named twice", ErrorReason.ATTACHMENT_NOT_FOUND);
    if (ids.length > this.limits.messageMaxFiles) {
      throw new AttachmentError(`at most ${this.limits.messageMaxFiles} files go with a message`, ErrorReason.TOO_MANY_ATTACHMENTS);
    }
    const found: Upload[] = [];
    for (const id of ids) {
      const u = this.waiting.get(id);
      if (!u || u.threadId !== threadId || u.received !== u.size) {
        throw new AttachmentError("no such upload, or not whole yet", ErrorReason.ATTACHMENT_NOT_FOUND, u?.name ?? "");
      }
      found.push(u);
    }
    const total = found.reduce((sum, u) => sum + u.size, 0);
    if (total > this.limits.messageMaxBytes) {
      throw new AttachmentError(`the files of a message are larger than ${this.limits.messageMaxBytes} bytes together`, ErrorReason.ATTACHMENT_TOO_LARGE);
    }
    for (const u of found) this.waiting.delete(u.id);
    return found;
  }

  /** Deletes the bytes of an upload taken earlier. */
  discard(u: Upload): void {
    rmSync(u.file, { force: true });
  }

  /** Waiting uploads (tests and logs). */
  get size(): number {
    return this.waiting.size;
  }

  private open(p: UploadPiece): Upload {
    if (p.size > this.limits.fileMaxBytes) {
      throw new AttachmentError(`the file is larger than ${this.limits.fileMaxBytes} bytes`, ErrorReason.ATTACHMENT_TOO_LARGE, p.name.slice(0, 255));
    }
    const waitingBytes = [...this.waiting.values()].reduce((sum, u) => sum + u.size, 0);
    if (this.waiting.size >= WAITING_MAX || waitingBytes + p.size > WAITING_MAX_BYTES) {
      throw new AttachmentError("too many files are waiting to be sent", ErrorReason.TOO_MANY_ATTACHMENTS);
    }
    const u: Upload = {
      id: p.uploadId,
      threadId: p.threadId,
      name: p.name.slice(0, NAME_MAX),
      mimeType: p.mimeType.slice(0, MIME_MAX),
      size: p.size,
      received: 0,
      file: join(this.dir, p.uploadId),
      createdAt: this.now(),
    };
    // A fresh file: a stale one of the same id must not carry over.
    closeSync(openSync(u.file, "w", 0o600));
    this.waiting.set(u.id, u);
    return u;
  }

  private drop(uploadId: string): void {
    const u = this.waiting.get(uploadId);
    if (!u) return;
    this.waiting.delete(uploadId);
    this.discard(u);
  }

  /** Drops uploads nobody sent within the hour, and files no upload owns. */
  private sweep(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const u of [...this.waiting.values()]) if (u.createdAt < cutoff) this.drop(u.id);
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      return;
    }
    for (const name of names) {
      if (this.waiting.has(name)) continue;
      const file = join(this.dir, name);
      try {
        // Taken a moment ago and being used: leave it to its owner for a while.
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** The limits as devices get them (MachineInfo.attachments). */
export function attachmentLimitsBody(l: AttachmentLimits) {
  return {
    fileMaxBytes: BigInt(l.fileMaxBytes),
    messageMaxBytes: BigInt(l.messageMaxBytes),
    messageMaxFiles: l.messageMaxFiles,
    imageMaxBytes: BigInt(Math.floor(l.imageMaxBytes)),
    pieceMaxBytes: l.pieceMaxBytes,
  };
}
