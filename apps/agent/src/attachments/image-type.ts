// The image types an AI takes as images, told by the first bytes of the file
// (never by the name or the type a device reports).

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const starts = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** The image type of these first bytes (12 are enough), or undefined when they are no such image. */
export function imageType(head: Uint8Array): ImageType | undefined {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return undefined;
}
