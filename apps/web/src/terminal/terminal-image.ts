// An image from the phone into the session's terminal (tunelo 2.7.1+): fitted
// to what the AI takes (as the chat's attachments are), uploaded in pieces
// over the machine's end-to-end encrypted link, saved by the machine in the
// session's folder (AttachmentSave), and its path typed into the terminal.
// Claude Code turns a pasted image path into an image of the prompt.
import { fitImage } from "../machines/attachment-image.ts";
import { newUploadId, uploadFile, type Limits } from "../machines/attachments.ts";
import type { MachineLink } from "../machines/link/machine-link.ts";

export class ImageTooLarge extends Error {}

/** Sends `file` to the machine for `threadId`; resolves with the saved file's absolute path. */
export async function imageIntoMachine(
	link: Pick<MachineLink, "request">,
	threadId: string,
	file: File,
	limits: Limits,
	onProgress: (fraction: number) => void,
	signal: AbortSignal,
): Promise<string> {
	const fitted = (await fitImage(file, limits.imageMaxBytes)) ?? file;
	if (fitted.size > limits.fileMaxBytes) throw new ImageTooLarge(file.name);
	const uploadId = newUploadId();
	await uploadFile(link, {
		threadId,
		uploadId,
		file: fitted,
		pieceBytes: limits.pieceMaxBytes,
		signal,
		onProgress: (sent) => onProgress(fitted.size === 0 ? 1 : sent / fitted.size),
	});
	const frame = await link.request({ case: "attachmentSave", value: { threadId, uploadId } });
	if (frame.body.case !== "attachmentSaved") throw new Error("the machine did not save the image");
	return frame.body.value.path;
}

const WINDOWS_PATH = /^[A-Za-z]:\\/;
const SHELL_SPECIAL = /([\s'"\\()&;|<>$`!*?#~[\]{}])/g;

/**
 * What to type for a saved file: its path as a shell or Claude Code reads a
 * dropped file (special characters escaped; a Windows path in quotes), as a
 * bracketed paste when the program asked for one, then a space.
 */
export function pathInput(path: string, bracketed: boolean): string {
	const text = WINDOWS_PATH.test(path) ? `"${path}"` : path.replace(SHELL_SPECIAL, "\\$1");
	return bracketed ? `\x1b[200~${text}\x1b[201~ ` : `${text} `;
}
