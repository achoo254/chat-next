// Stands in for the form-data package (and its 17 dependencies) in the bundle: zca-js builds each
// upload request as one multipart body from Buffers (uploadAttachment, upthumb) and reads it back
// with getHeaders() and getBuffer(). That is all this does; streams, files on disk and the rest of
// the package are not supported and throw. The body is built in memory: nothing is written to disk.
import { randomBytes } from "node:crypto";

/** Characters that would end a header line or a quoted header value. */
const UNSAFE_IN_HEADER = /[\r\n"]/g;

function headerValue(value) {
	return String(value).replace(UNSAFE_IN_HEADER, "_");
}

export default class FormData {
	#boundary = `--------------------------${randomBytes(12).toString("hex")}`;
	#parts = [];

	/** Adds one field whose value is the bytes of a Buffer (or a Uint8Array), with an optional file name and type. */
	append(name, value, options) {
		if (!(value instanceof Uint8Array)) throw new TypeError("form-data: only bytes can be appended in this build");
		const filename = typeof options?.filename === "string" ? options.filename : undefined;
		const contentType = typeof options?.contentType === "string" ? options.contentType : "application/octet-stream";
		let disposition = `form-data; name="${headerValue(name)}"`;
		if (filename !== undefined) disposition += `; filename="${headerValue(filename)}"`;
		const head = `--${this.#boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${headerValue(contentType)}\r\n\r\n`;
		this.#parts.push(Buffer.from(head, "utf8"), Buffer.from(value.buffer, value.byteOffset, value.byteLength), Buffer.from("\r\n"));
	}

	getBoundary() {
		return this.#boundary;
	}

	/** The request headers of the body; `extra` headers are kept. */
	getHeaders(extra = {}) {
		return { ...extra, "content-type": `multipart/form-data; boundary=${this.#boundary}` };
	}

	/** The whole body. */
	getBuffer() {
		return Buffer.concat([...this.#parts, Buffer.from(`--${this.#boundary}--\r\n`)]);
	}
}
