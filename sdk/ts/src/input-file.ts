/**
 * A file to upload: its name (sent as the multipart part's filename, which
 * becomes the message's `file_name`) and its bytes.
 */
export class InputFile {
	/** File name shown to users, for example `report.pdf`. */
	readonly fileName: string;
	/** The file's content. */
	readonly data: Blob | Uint8Array;

	constructor(fileName: string, data: Blob | Uint8Array) {
		if (fileName === "") {
			throw new TypeError("InputFile needs a file name");
		}
		this.fileName = fileName;
		this.data = data;
	}

	/** The content as a Blob, ready for a FormData part. */
	toBlob(): Blob {
		if (this.data instanceof Blob) {
			return this.data;
		}
		// Copy into a plain ArrayBuffer view: Blob refuses shared memory.
		return new Blob([new Uint8Array(this.data)]);
	}
}
