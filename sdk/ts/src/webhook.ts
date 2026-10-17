import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Update, WebhookAnswer } from "./generated.ts";

/** Largest webhook body accepted, in bytes. */
export const MAX_WEBHOOK_BODY = 1 << 20;
/** How far `X-Bot-Timestamp` may be from the local clock, in seconds. */
export const MAX_CLOCK_SKEW_S = 300;
const DEDUPE_SIZE = 1000;

/** Request headers as given by `node:http` (lowercase keys) or a fetch `Headers`. */
export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Checks a webhook request: `X-Bot-Api-Secret-Token` equals `secret`,
 * `X-Bot-Signature` is `v1=` + hex(HMAC-SHA256(secret, timestamp + "." + raw
 * body)), and `X-Bot-Timestamp` is within 5 minutes of `now`. Secret and
 * signature are compared in constant time.
 *
 * @param rawBody the body exactly as received, before any JSON parsing.
 */
export function verifyWebhook(
	headers: WebhookHeaders,
	rawBody: Uint8Array | string,
	secret: string,
	now: Date = new Date(),
): boolean {
	if (secret === "") {
		return false;
	}
	const timestamp = header(headers, "x-bot-timestamp");
	if (!/^\d{1,15}$/.test(timestamp)) {
		return false;
	}
	if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_S) {
		return false;
	}
	const expected =
		"v1=" + createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
	// Evaluate both comparisons so the answer time does not tell which failed.
	const secretOk = sameText(header(headers, "x-bot-api-secret-token"), secret);
	const signatureOk = sameText(header(headers, "x-bot-signature"), expected);
	return secretOk && signatureOk;
}

/** Handles one update; may return a method for the server to run as the answer. */
export type UpdateHandler = (update: Update) => WebhookAnswer | undefined | Promise<WebhookAnswer | undefined>;

/** Options of `webhookHandler`. */
export interface WebhookHandlerOptions {
	/** The secret given to `setWebhook`. */
	readonly secret: string;
	/** Called once per new update. Throwing answers 500 so the server delivers it again. */
	readonly onUpdate: UpdateHandler;
	/** Receives handler errors (default: `console.error`). */
	readonly onError?: (error: unknown, update: Update) => void;
}

/**
 * A `node:http` request listener for the bot's webhook.
 *
 * Answers 405 to anything but POST, 413 to bodies over 1 MiB, 401 (no body)
 * when `verifyWebhook` fails, 400 to a body that is not an update, 200 to an
 * update already handled among the last 1000, 200 with JSON when the handler
 * returns a `WebhookAnswer`, 204 otherwise, and 500 when the handler throws.
 */
export function webhookHandler(options: WebhookHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
	if (options.secret === "") {
		throw new TypeError("webhookHandler needs the webhook secret");
	}
	const onError = options.onError ?? ((error: unknown) => console.error("webhook handler failed:", error));
	const handled = new RecentIds(DEDUPE_SIZE);

	const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (req.method !== "POST") {
			req.resume();
			finish(res, 405, { Allow: "POST" });
			return;
		}
		const body = await readBody(req, MAX_WEBHOOK_BODY);
		if (body === undefined) {
			finish(res, 413, { Connection: "close" });
			return;
		}
		if (!verifyWebhook(req.headers, body, options.secret)) {
			finish(res, 401);
			return;
		}
		const update = parseUpdate(body);
		if (update === undefined) {
			finish(res, 400);
			return;
		}
		if (handled.has(update.update_id)) {
			finish(res, 200);
			return;
		}
		let answer: WebhookAnswer | undefined;
		try {
			answer = await options.onUpdate(update);
		} catch (error) {
			onError(error, update);
			finish(res, 500);
			return;
		}
		handled.add(update.update_id);
		if (answer === undefined) {
			finish(res, 204);
			return;
		}
		const json = JSON.stringify(answer);
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(json),
		});
		res.end(json);
	};

	return (req, res) => {
		serve(req, res).catch((error: unknown) => {
			// Reading the request failed (client went away); nothing to answer.
			if (!res.headersSent) {
				finish(res, 400);
			}
			if (!isConnectionError(error)) {
				console.error("webhook request failed:", error);
			}
		});
	};
}

/** Insertion-ordered set that forgets its oldest ids beyond `size`. */
class RecentIds {
	readonly #ids = new Set<number>();
	readonly #size: number;

	constructor(size: number) {
		this.#size = size;
	}

	has(id: number): boolean {
		return this.#ids.has(id);
	}

	add(id: number): void {
		this.#ids.add(id);
		if (this.#ids.size > this.#size) {
			const oldest = this.#ids.values().next();
			if (!oldest.done) {
				this.#ids.delete(oldest.value);
			}
		}
	}
}

function finish(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
	res.writeHead(status, headers);
	res.end();
}

/** The body, or undefined when it is larger than `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			req.resume();
			resolve(undefined);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		// Events instead of for-await: leaving an async iterator destroys the
		// socket, and the 413 answer still has to go out on it.
		req.on("data", (chunk: Buffer) => {
			if (tooLarge) {
				return;
			}
			size += chunk.length;
			if (size > limit) {
				tooLarge = true;
				chunks.length = 0;
				resolve(undefined);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!tooLarge) {
				resolve(Buffer.concat(chunks));
			}
		});
		req.on("error", reject);
	});
}

function parseUpdate(body: Buffer): Update | undefined {
	let json: unknown;
	try {
		json = JSON.parse(body.toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return undefined;
	}
	const id: unknown = (json as { update_id?: unknown }).update_id;
	return typeof id === "number" && Number.isSafeInteger(id) ? (json as Update) : undefined;
}

function header(headers: WebhookHeaders, name: string): string {
	if (headers instanceof Headers) {
		return headers.get(name) ?? "";
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) {
			return typeof value === "string" ? value : (value?.[0] ?? "");
		}
	}
	return "";
}

/** Constant time for equal lengths; the length itself is not secret. */
function sameText(got: string, want: string): boolean {
	const a = Buffer.from(got);
	const b = Buffer.from(want);
	return a.length === b.length && timingSafeEqual(a, b);
}

function isConnectionError(error: unknown): boolean {
	const code: unknown = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE";
}
