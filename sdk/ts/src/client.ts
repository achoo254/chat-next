import { GeneratedMethods } from "./generated.ts";
import type { CallOptions, File, Message, SendAlbumUpload, SendMediaUpload } from "./generated.ts";
import type { InputFile } from "./input-file.ts";
import { sleep } from "./sleep.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_S = 1;

/** Options of a `Client`. */
export interface ClientOptions {
	/**
	 * Bot API base URL of your chat server, for example
	 * `https://chat.example.com/bot/v1`. Required: the SDK has no default server.
	 */
	readonly baseUrl: string;
	/** Timeout of one request in milliseconds (default 60 000); a long poll adds its own `timeout`. */
	readonly timeoutMs?: number;
	/** How many times a `429 rate_limited` or `503 unavailable` answer is retried (default 3). */
	readonly retries?: number;
}

/** One low-level request: query parameters, a JSON body or a multipart form. */
export interface RequestOptions extends CallOptions {
	/** Multipart body; exclusive with `body`. */
	readonly form?: FormData;
	/** Cancels the request (and any retry wait). */
	readonly signal?: AbortSignal;
}

/**
 * An error answer of the Bot API (`{"ok": false, "error": …}`). Branch on
 * `code`, never on `description`.
 */
export class ApiError extends Error {
	/** HTTP status of the answer. */
	readonly status: number;
	/** Stable error code, for example `rate_limited` or `conflict`. */
	readonly code: string;
	/** Human-readable detail; do not parse. */
	readonly description: string;
	/** Seconds to wait before retrying; 0 when the server did not say. */
	readonly retryAfter: number;

	constructor(status: number, code: string, description: string, retryAfter = 0) {
		super(`${code} (HTTP ${status}): ${description}`);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** The request did not get an HTTP answer (connection failure or timeout). */
export class NetworkError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NetworkError";
	}
}

/**
 * Bot API client. Every API method of `GeneratedMethods` is available, plus
 * multipart uploads and file downloads.
 *
 * Retries `429 rate_limited` and `503 unavailable` answers after
 * `retry_after` (or 1 s), up to `retries` times; a GET whose connection fails
 * is retried the same way. Nothing else is retried: a POST may already have
 * run. The token is only ever sent in the `Authorization` header.
 */
export class Client extends GeneratedMethods {
	readonly #token: string;
	readonly #baseUrl: string;
	readonly #timeoutMs: number;
	readonly #retries: number;

	constructor(token: string, options: ClientOptions) {
		super();
		if (token === "") {
			throw new TypeError("Client needs a bot token");
		}
		// `?.`: a JavaScript caller may leave the options out altogether.
		const baseUrl = checkBaseUrl(options?.baseUrl);
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const retries = options.retries ?? DEFAULT_RETRIES;
		if (!(timeoutMs > 0)) {
			throw new RangeError("timeoutMs must be positive");
		}
		if (!Number.isInteger(retries) || retries < 0) {
			throw new RangeError("retries must be a non-negative integer");
		}
		this.#token = token;
		this.#baseUrl = baseUrl;
		this.#timeoutMs = timeoutMs;
		this.#retries = retries;
	}

	protected call<T>(method: string, path: string, options: CallOptions): Promise<T> {
		return this.request<T>(method, path, options);
	}

	/**
	 * Sends one request and returns the envelope's `result`. Use it for API
	 * methods newer than this SDK, or to pass an AbortSignal.
	 *
	 * @throws ApiError for an error answer, NetworkError when no answer came,
	 *   or the signal's reason when `signal` aborted.
	 */
	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const url = this.#baseUrl + path + queryString(options.query);
		const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
		let body: string | FormData | undefined;
		if (options.form !== undefined) {
			body = options.form;
		} else if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.body);
		}
		const timeoutMs = this.#timeoutMs + longPollSeconds(path, options.query) * 1000;

		for (let attempt = 0; ; attempt++) {
			const canRetry = attempt < this.#retries;
			let response: Response;
			try {
				response = await fetch(url, {
					method,
					headers,
					...(body === undefined ? {} : { body }),
					signal: withTimeout(timeoutMs, options.signal),
				});
			} catch (error) {
				options.signal?.throwIfAborted();
				if (method === "GET" && canRetry) {
					await sleep(DEFAULT_RETRY_DELAY_S * 1000, options.signal);
					options.signal?.throwIfAborted();
					continue;
				}
				throw new NetworkError(`${method} ${path}: ${describe(error)}`, { cause: error });
			}

			const outcome = await readEnvelope(response, options.signal);
			if (!(outcome instanceof ApiError)) {
				return outcome.result as T;
			}
			if (canRetry && isRetryable(outcome)) {
				await sleep((outcome.retryAfter || DEFAULT_RETRY_DELAY_S) * 1000, options.signal);
				options.signal?.throwIfAborted();
				continue;
			}
			throw outcome;
		}
	}

	/**
	 * Uploads a photo, video, audio, voice message or document
	 * (`POST /messages:sendMedia` as `multipart/form-data`).
	 */
	sendMediaUpload(request: SendMediaUpload, options: { signal?: AbortSignal } = {}): Promise<Message> {
		const { file, ...fields } = request;
		const form = formOf(fields);
		form.append("file", file.toBlob(), file.fileName);
		return this.request<Message>("POST", "/messages:sendMedia", { form, ...signalOf(options) });
	}

	/**
	 * Uploads an album (`POST /messages:sendAlbum` as `multipart/form-data`).
	 * `request.items` is the JSON string of the AlbumItem list; every item with
	 * `attach` needs the file of that name in `files`.
	 */
	sendAlbumUpload(
		request: SendAlbumUpload,
		files: Readonly<Record<string, InputFile>>,
		options: { signal?: AbortSignal } = {},
	): Promise<Message[]> {
		checkAttachments(request.items, files);
		const form = formOf(request);
		for (const [name, file] of Object.entries(files)) {
			form.append(name, file.toBlob(), file.fileName);
		}
		return this.request<Message[]>("POST", "/messages:sendAlbum", { form, ...signalOf(options) });
	}

	/**
	 * Downloads a file's bytes from its `url` (see `getFile`). The URL carries
	 * its own authorization, so the token is not sent.
	 */
	async downloadFile(file: Pick<File, "url"> | string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
		const url = typeof file === "string" ? file : file.url;
		let response: Response;
		try {
			response = await fetch(url, { signal: withTimeout(this.#timeoutMs, options.signal) });
		} catch (error) {
			options.signal?.throwIfAborted();
			throw new NetworkError(`download: ${describe(error)}`, { cause: error });
		}
		if (!response.ok) {
			const outcome = await readEnvelope(response, options.signal);
			throw outcome instanceof ApiError
				? outcome
				: new ApiError(response.status, "download_failed", `download answered HTTP ${response.status}`);
		}
		try {
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			options.signal?.throwIfAborted();
			throw new NetworkError(`download: ${describe(error)}`, { cause: error });
		}
	}
}

function isRetryable(error: ApiError): boolean {
	return (error.status === 429 && error.code === "rate_limited") || (error.status === 503 && error.code === "unavailable");
}

function signalOf(options: { signal?: AbortSignal }): { signal?: AbortSignal } {
	return options.signal === undefined ? {} : { signal: options.signal };
}

function withTimeout(ms: number, signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** Long polls wait up to their `timeout` seconds on the server. */
function longPollSeconds(path: string, query: object | undefined): number {
	if (path !== "/updates" || query === undefined) {
		return 0;
	}
	const timeout: unknown = (query as { timeout?: unknown }).timeout;
	return typeof timeout === "number" && timeout > 0 ? timeout : 0;
}

function queryString(query: object | undefined): string {
	if (query === undefined) {
		return "";
	}
	const params = new URLSearchParams();
	const entries: [string, unknown][] = Object.entries(query);
	for (const [key, value] of entries) {
		if (value === undefined || value === null) {
			continue;
		}
		params.append(key, Array.isArray(value) ? value.join(",") : String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

/** Form fields of a multipart request; objects become JSON strings. */
function formOf(fields: object): FormData {
	const form = new FormData();
	const entries: [string, unknown][] = Object.entries(fields);
	for (const [key, value] of entries) {
		if (value === undefined || value === null) {
			continue;
		}
		form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
	}
	return form;
}

function checkAttachments(items: string, files: Readonly<Record<string, InputFile>>): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(items);
	} catch {
		throw new TypeError("SendAlbumUpload.items must be a JSON array of AlbumItem");
	}
	if (!Array.isArray(parsed)) {
		throw new TypeError("SendAlbumUpload.items must be a JSON array of AlbumItem");
	}
	const attached = new Set<string>();
	for (const item of parsed) {
		const attach: unknown = isRecord(item) ? item["attach"] : undefined;
		if (typeof attach === "string") {
			if (!Object.hasOwn(files, attach)) {
				throw new TypeError(`album item attaches "${attach}" but no such file was given`);
			}
			attached.add(attach);
		}
	}
	for (const name of Object.keys(files)) {
		if (!attached.has(name)) {
			throw new TypeError(`file "${name}" is not attached by any album item`);
		}
	}
}

type Envelope = { readonly result: unknown } | ApiError;

/** Reads an answer: the envelope's result, or the ApiError it describes. */
async function readEnvelope(response: Response, signal: AbortSignal | undefined): Promise<Envelope> {
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		signal?.throwIfAborted();
		throw new NetworkError(`reading the answer failed: ${describe(error)}`, { cause: error });
	}
	const headerRetry = parseRetryAfter(response.headers.get("retry-after"));
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return new ApiError(response.status, "invalid_response", `HTTP ${response.status} without a JSON envelope`, headerRetry);
	}
	if (isRecord(json) && json["ok"] === true && "result" in json) {
		return { result: json["result"] };
	}
	const error = isRecord(json) && json["ok"] === false ? json["error"] : undefined;
	if (isRecord(error) && typeof error["code"] === "string") {
		const description = typeof error["description"] === "string" ? error["description"] : "";
		const retryAfter = typeof error["retry_after"] === "number" && error["retry_after"] > 0 ? error["retry_after"] : headerRetry;
		return new ApiError(response.status, error["code"], description, retryAfter);
	}
	return new ApiError(response.status, "invalid_response", `HTTP ${response.status} with an unexpected body`, headerRetry);
}

/** `Retry-After` in seconds (integer or HTTP date); 0 when absent or invalid. */
function parseRetryAfter(value: string | null): number {
	if (value === null || value.trim() === "") {
		return 0;
	}
	if (/^\d+$/.test(value.trim())) {
		return Number(value.trim());
	}
	const date = Date.parse(value);
	return Number.isNaN(date) ? 0 : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
		return error.message + cause;
	}
	return String(error);
}

/**
 * The Bot API base URL without trailing slashes. Throws when it is missing
 * or not an http(s) URL: the SDK has no default server.
 */
function checkBaseUrl(baseUrl: string | undefined): string {
	if (baseUrl === undefined || baseUrl === "") {
		throw new TypeError("Client needs options.baseUrl, the Bot API URL of your chat server, e.g. https://chat.example.com/bot/v1");
	}
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new TypeError(`baseUrl must be an absolute http(s) URL, e.g. https://chat.example.com/bot/v1, not "${baseUrl}"`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TypeError(`baseUrl must be an http(s) URL, not "${baseUrl}"`);
	}
	// Request paths are appended to it as text: a query, fragment, credentials
	// or surrounding spaces (which URL parsing forgives) would corrupt them.
	if (baseUrl !== baseUrl.trim() || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
		throw new TypeError(`baseUrl must be a plain URL without query, fragment, credentials or spaces, not "${baseUrl}"`);
	}
	return baseUrl.replace(/\/+$/, "");
}
