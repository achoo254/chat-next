/** Ring buffer storage for inspector request/response entries */

export interface InspectorEntry {
	id: string;
	timestamp: number;
	subdomain?: string;
	method: string;
	path: string;
	requestHeaders: Record<string, string | string[]>;
	requestBody: string | null;
	status: number;
	responseHeaders: Record<string, string | string[]>;
	responseBody: string | null;
	durationMs: number;
	/** "normal" for tunnel traffic, "replay" for replayed requests */
	entryType: "normal" | "replay";
	/** Original entry ID if this is a replay */
	originalId?: string;
}

/** Lightweight entry without bodies — for list API */
export type InspectorEntrySummary = Omit<
	InspectorEntry,
	"requestBody" | "responseBody" | "requestHeaders" | "responseHeaders"
>;

export type RequestStoreListener = (entry: InspectorEntry) => void;

const DEFAULT_MAX_SIZE = 500;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB per body

export class RequestStore {
	private entries: InspectorEntry[] = [];
	private readonly maxSize: number;
	private listeners: RequestStoreListener[] = [];

	constructor(maxSize = DEFAULT_MAX_SIZE) {
		this.maxSize = maxSize;
	}

	add(entry: InspectorEntry): void {
		// Truncate bodies if too large
		if (
			entry.requestBody &&
			Buffer.byteLength(entry.requestBody, "utf-8") > MAX_BODY_BYTES
		) {
			entry.requestBody = entry.requestBody.slice(0, MAX_BODY_BYTES);
		}
		if (
			entry.responseBody &&
			Buffer.byteLength(entry.responseBody, "utf-8") > MAX_BODY_BYTES
		) {
			entry.responseBody = entry.responseBody.slice(0, MAX_BODY_BYTES);
		}

		this.entries.push(entry);
		// Evict oldest if over capacity
		if (this.entries.length > this.maxSize) {
			this.entries.shift();
		}
		for (const listener of this.listeners) {
			listener(entry);
		}
	}

	list(filter?: {
		subdomain?: string;
		status?: string;
		q?: string;
	}): InspectorEntrySummary[] {
		let result = this.entries;

		if (filter?.subdomain) {
			result = result.filter((e) => e.subdomain === filter.subdomain);
		}
		if (filter?.status) {
			const statusPrefix = filter.status.replace(/x/gi, "");
			result = result.filter((e) => String(e.status).startsWith(statusPrefix));
		}
		if (filter?.q) {
			const q = filter.q.toLowerCase();
			result = result.filter(
				(e) =>
					e.path.toLowerCase().includes(q) ||
					e.method.toLowerCase().includes(q),
			);
		}

		// Return summaries (no bodies) in reverse chronological order
		return result
			.map(
				({
					requestBody,
					responseBody,
					requestHeaders,
					responseHeaders,
					...summary
				}) => summary,
			)
			.reverse();
	}

	get(id: string): InspectorEntry | undefined {
		return this.entries.find((e) => e.id === id);
	}

	clear(): void {
		this.entries = [];
	}

	onAdd(callback: RequestStoreListener): void {
		this.listeners.push(callback);
	}

	removeListener(callback: RequestStoreListener): void {
		this.listeners = this.listeners.filter((l) => l !== callback);
	}

	get size(): number {
		return this.entries.length;
	}

	getSubdomains(): string[] {
		const set = new Set<string>();
		for (const entry of this.entries) {
			if (entry.subdomain) set.add(entry.subdomain);
		}
		return [...set];
	}
}
