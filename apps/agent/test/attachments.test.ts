// Files sent with a message: uploads in pieces, names made safe, files saved
// in the session's folder (kept out of git), images handed to Claude as
// images and shown again from the thread.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason, Role } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { imageType } from "../src/attachments/image-type.ts";
import { textForAi } from "../src/attachments/message-attachments.ts";
import { ATTACHMENTS_FOLDER, dayFolder, keepOutOfGit, safeFileName, saveInFolder } from "../src/attachments/project-files.ts";
import { AttachmentError, Uploads } from "../src/attachments/uploads.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { fakeProvider } from "./fake-provider.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const consent = { sensitive: false, projectSettings: false };
const never = () => false;

function reason(fn: () => unknown): ErrorReason | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AttachmentError) return err.reason;
    throw err;
  }
  return undefined;
}

describe("file names", () => {
  it("keeps only the last part of a path, so a name never leaves the folder", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\Windows\\win.ini")).toBe("win.ini");
    expect(safeFileName("/abs/path/report.pdf")).toBe("report.pdf");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(".")).toBe("file");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("...hidden")).toBe("hidden");
  });

  it("drops what a file system refuses", () => {
    expect(safeFileName('a<b>c:d"e|f?g*h\u0001.txt')).toBe("a_b_c_d_e_f_g_h_.txt");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("nul")).toBe("_nul");
    expect(safeFileName("name. . ")).toBe("name");
    expect(safeFileName("Ảnh chụp màn hình.png")).toBe("Ảnh chụp màn hình.png");
  });

  it("shortens a long name and keeps its extension", () => {
    const long = `${"x".repeat(300)}.tar.gz`;
    const safe = safeFileName(long);
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.endsWith(".gz")).toBe(true);
  });
});

describe("image types", () => {
  it("goes by the bytes, not the name", () => {
    expect(imageType(PNG)).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageType(new TextEncoder().encode("%PDF-1.7"))).toBeUndefined();
    expect(imageType(new TextEncoder().encode("<svg"))).toBeUndefined();
  });
});

describe("uploads", () => {
  const piece = (over: Partial<Parameters<Uploads["put"]>[0]> = {}) => ({
    uploadId: "upload-0001",
    threadId: "t1",
    name: "a.txt",
    mimeType: "text/plain",
    size: 6,
    offset: 0,
    data: new TextEncoder().encode("abc"),
    ...over,
  });

  it("takes pieces in order and hands the whole file to its thread once", () => {
    const u = new Uploads(tempDir());
    u.put(piece());
    expect(reason(() => u.take("t1", ["upload-0001"]))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    u.put(piece({ offset: 3, data: new TextEncoder().encode("def") }));
    expect(reason(() => u.take("t2", ["upload-0001"]))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    const [whole] = u.take("t1", ["upload-0001"]);
    expect(whole && readFileSync(whole.file, "utf8")).toBe("abcdef");
    expect(reason(() => u.take("t1", ["upload-0001"]))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
  });

  it("drops an upload on a piece out of order, and on cancel", () => {
    const u = new Uploads(tempDir());
    u.put(piece());
    expect(reason(() => u.put(piece({ offset: 4, data: new Uint8Array(2) })))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    expect(u.size).toBe(0);
    u.put(piece());
    u.cancel("upload-0001");
    expect(u.size).toBe(0);
    u.cancel("never-there");
  });

  it("refuses files and messages past the limits", () => {
    const u = new Uploads(tempDir(), { limits: { fileMaxBytes: 10, messageMaxBytes: 12, messageMaxFiles: 2, pieceMaxBytes: 4 } });
    expect(reason(() => u.put(piece({ size: 11 })))).toBe(ErrorReason.ATTACHMENT_TOO_LARGE);
    expect(reason(() => u.put(piece({ data: new Uint8Array(5) })))).toBe(ErrorReason.ATTACHMENT_TOO_LARGE);
    for (const id of ["upload-a001", "upload-a002", "upload-a003"]) {
      u.put(piece({ uploadId: id, size: 4, data: new Uint8Array(4) }));
    }
    expect(reason(() => u.take("t1", ["upload-a001", "upload-a002", "upload-a003"]))).toBe(ErrorReason.TOO_MANY_ATTACHMENTS);
    u.put(piece({ uploadId: "upload-b001", size: 10, data: new Uint8Array(4) }));
    u.put(piece({ uploadId: "upload-b001", size: 10, offset: 4, data: new Uint8Array(4) }));
    u.put(piece({ uploadId: "upload-b001", size: 10, offset: 8, data: new Uint8Array(2) }));
    expect(reason(() => u.take("t1", ["upload-a001", "upload-b001"]))).toBe(ErrorReason.ATTACHMENT_TOO_LARGE);
    // A refused message takes nothing: both are still there.
    expect(u.take("t1", ["upload-a001", "upload-a002"])).toHaveLength(2);
  });

  it("refuses ids that could name a path", () => {
    const u = new Uploads(tempDir());
    expect(reason(() => u.put(piece({ uploadId: "../../x-escape" })))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
  });

  it("forgets an upload nobody sent within the hour", () => {
    let now = 1_000_000;
    const u = new Uploads(tempDir(), { now: () => now });
    u.put(piece({ size: 3 }));
    now += 61 * 60_000;
    expect(reason(() => u.take("t1", ["upload-0001"]))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
  });
});

describe("files saved in the session's folder", () => {
  const at = new Date(2026, 10, 9, 13, 25);

  it("saves under the day's folder, numbers a taken name and stays out of git", () => {
    const root = tempDir();
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mkdirSync(join(repo, "app"));
    const src = join(root, "src.bin");
    writeFileSync(src, "hello");
    const first = saveInFolder(join(repo, "app"), src, "../../notes.md", { isSensitive: never, now: at });
    const second = saveInFolder(join(repo, "app"), src, "notes.md", { isSensitive: never, now: at });
    expect(first).toBe(`${ATTACHMENTS_FOLDER}/2026-11-09/notes.md`);
    expect(second).toBe(`${ATTACHMENTS_FOLDER}/2026-11-09/notes (2).md`);
    expect(readFileSync(join(repo, "app", first), "utf8")).toBe("hello");
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === `${ATTACHMENTS_FOLDER}/`)).toHaveLength(1);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("finds the shared exclude list of a linked work tree", () => {
    const root = tempDir();
    const common = join(root, "main", ".git");
    const linked = join(common, "worktrees", "feature");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "commondir"), "../..\n");
    const tree = join(root, "feature");
    mkdirSync(tree);
    writeFileSync(join(tree, ".git"), `gitdir: ${linked}\n`);
    keepOutOfGit(tree);
    expect(readFileSync(join(common, "info", "exclude"), "utf8")).toContain(`${ATTACHMENTS_FOLDER}/`);
  });

  it("refuses an attachments folder that links out of the session's folder", () => {
    const root = tempDir();
    const cwd = join(root, "proj");
    const outside = join(root, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, ATTACHMENTS_FOLDER));
    const src = join(root, "src");
    writeFileSync(src, "x");
    expect(reason(() => saveInFolder(cwd, src, "a.txt", { isSensitive: never, now: at }))).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
    expect(existsSync(join(outside, dayFolder(at)))).toBe(false);
  });

  it("refuses a sensitive target", () => {
    const root = tempDir();
    const src = join(root, "src");
    writeFileSync(src, "x");
    const isSensitive = (p: string) => p.startsWith(join(root, "secret"));
    mkdirSync(join(root, "secret"));
    expect(reason(() => saveInFolder(join(root, "secret"), src, "a.txt", { isSensitive, now: at }))).toBe(ErrorReason.SENSITIVE_FOLDER);
    expect(existsSync(join(root, "secret", ATTACHMENTS_FOLDER))).toBe(false);
  });

  it("tells the AI where the files are", () => {
    expect(textForAi("look", [])).toBe("look");
    expect(textForAi("look", [{ path: ".tunelo-attachments/2026-11-09/a.pdf", size: 2048 }])).toBe(
      "look\n\nThe user attached this file, saved in the working directory:\n- .tunelo-attachments/2026-11-09/a.pdf (2.0 KB)",
    );
    expect(textForAi("", [{ path: "x", size: 1 }, { path: "y", size: 3 * 1024 * 1024 }])).toBe(
      "The user attached these files, saved in the working directory:\n- x (1 B)\n- y (3.0 MB)",
    );
  });
});

describe("a message with files, through the core", () => {
  const upload = (core: ReturnType<typeof makeCore>["core"], threadId: string, uploadId: string, name: string, data: Uint8Array) =>
    core.upload({ uploadId, threadId, name, mimeType: "", size: data.length, offset: 0, data });

  it("gives Claude the image as an image and the file as a path, and keeps both on the message", async () => {
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent, device: "test" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state !== 1));
    upload(core, t.id, "image-0001", "shot.png", PNG);
    upload(core, t.id, "file-00001", "../spec.pdf", new TextEncoder().encode("%PDF-1.7"));
    await core.send(t.id, "what is this", "m1", ["image-0001", "file-00001"]);
    const items = await until(core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== 1).length >= 2);
    const sent = sdk.log.prompts?.at(-1);
    if (!Array.isArray(sent)) throw new Error("expected content blocks");
    expect(sent[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG).toString("base64") } });
    const text = sent[1] as { type: string; text: string };
    expect(text.type).toBe("text");
    expect(text.text).toContain("what is this");
    expect(text.text).toMatch(/\.tunelo-attachments\/\d{4}-\d{2}-\d{2}\/spec\.pdf/);
    const user = byCase(items, "text").filter((i) => i.body.value.role === Role.USER).at(-1);
    expect(user?.body.value.text).toBe("what is this");
    expect(user?.body.value.attachments.map((a) => [a.name, a.image, a.mimeType])).toEqual([
      ["shot.png", true, "image/png"],
      ["../spec.pdf", false, ""],
    ]);
    const path = user?.body.value.attachments[1]?.path ?? "";
    expect(readFileSync(join(work, path), "utf8")).toBe("%PDF-1.7");
    expect(core.attachmentImage(t.id, "image-0001")).toEqual({ mimeType: "image/png", data: PNG });
    expect(() => core.attachmentImage(t.id, "file-00001")).toThrow(AttachmentError);
    await core.stop();
  });

  it("saves an image as a file for an AI that takes no images, and sends files alone", async () => {
    const p = fakeProvider();
    const { core, work } = makeCore([p]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
    upload(core, t.id, "image-0002", "shot.png", PNG);
    await core.send(t.id, "", "m2", ["image-0002"]);
    expect(p.log.sent.at(-1)).toMatch(/^The user attached this file, saved in the working directory:\n- \.tunelo-attachments\/.+\/shot\.png \(19 B\)$/);
    const user = byCase(core.snapshot(t.id), "text").filter((i) => i.body.value.role === Role.USER).at(-1);
    expect(user?.body.value.attachments[0]?.image).toBe(false);
    expect(core.list().find((x) => x.id === t.id)?.preview).toBeTruthy();
    await core.stop();
  });

  it("refuses a message naming an upload it does not hold, and an empty one", async () => {
    const p = fakeProvider();
    const { core, work } = makeCore([p]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
    await expect(core.send(t.id, "x", "m3", ["missing-001"])).rejects.toMatchObject({ reason: ErrorReason.ATTACHMENT_NOT_FOUND });
    await expect(core.send(t.id, " ", "m4", [])).rejects.toMatchObject({ reason: ErrorReason.EMPTY_MESSAGE });
    // The refused message id is free: the same message goes once it is right.
    await core.send(t.id, "x", "m3", []);
    expect(p.log.sent.at(-1)).toBe("x");
    await core.stop();
  });

  it("saves an upload in the session's folder for its terminal and gives the absolute path, once", async () => {
    const p = fakeProvider();
    const { core, work } = makeCore([p]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
    upload(core, t.id, "image-0003", "../ảnh chụp.png", PNG);
    const path = core.saveUpload(t.id, "image-0003");
    expect(path.startsWith(join(work, ATTACHMENTS_FOLDER))).toBe(true);
    expect(path.endsWith("ảnh chụp.png")).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
    // Gone once saved, and never for another thread's upload.
    expect(reason(() => core.saveUpload(t.id, "image-0003"))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    const other = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
    upload(core, other.id, "image-0004", "x.png", PNG);
    expect(reason(() => core.saveUpload(t.id, "image-0004"))).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    await core.stop();
  });

  it("refuses the first piece of an upload for a thread that does not exist", () => {
    const { core } = makeCore([fakeProvider()]);
    expect(() => upload(core, "nope", "upload-0009", "a", new Uint8Array(1))).toThrow(/no such thread/);
  });
});
