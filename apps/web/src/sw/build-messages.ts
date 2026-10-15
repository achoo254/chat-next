// The one message between the app's tabs and its service worker: "which
// build do you run?". A build is named by its entry script, the module
// index.html loads ("/assets/index-<hash>.js"); it changes with any change of
// the app's code. Both sides ask and answer it over a MessageChannel:
//
// - a tab asks the worker that controls it, at start and when a new worker
//   takes over; a different answer after a takeover means the server has a
//   newer build than the tab runs (the "Đã có bản mới" bar);
// - the worker, on each question, asks every open tab back, so it can drop
//   the caches of builds no tab runs any more (cachesToDelete).

export const BUILD_QUERY = "app-shell:build?";
export const BUILD_REPLY = "app-shell:build";

/** How long either side waits for an answer; a silent tab or worker counts as unknown. */
export const BUILD_REPLY_TIMEOUT_MS = 1500;

export interface BuildQuery {
	readonly type: typeof BUILD_QUERY;
}

export interface BuildReply {
	readonly type: typeof BUILD_REPLY;
	readonly entry: string;
}

export function isBuildQuery(data: unknown): data is BuildQuery {
	return typeof data === "object" && data !== null && (data as { type?: unknown }).type === BUILD_QUERY;
}

/** The entry of a build reply, or null for anything else. */
export function replyEntry(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const { type, entry } = data as { type?: unknown; entry?: unknown };
	return type === BUILD_REPLY && typeof entry === "string" && entry.startsWith("/assets/") ? entry : null;
}

/** Something that takes a message with a port: a Client in the worker, a ServiceWorker in a tab. */
export interface MessageTarget {
	postMessage(message: unknown, transfer: Transferable[]): void;
}

/** Asks target which build it runs; null when it does not answer in time (or cannot be asked). */
export function askBuild(target: MessageTarget, timeoutMs = BUILD_REPLY_TIMEOUT_MS): Promise<string | null> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		const done = (entry: string | null): void => {
			clearTimeout(timer);
			channel.port1.close();
			resolve(entry);
		};
		const timer = setTimeout(() => done(null), timeoutMs);
		channel.port1.onmessage = (event: MessageEvent) => done(replyEntry(event.data));
		try {
			const query: BuildQuery = { type: BUILD_QUERY };
			target.postMessage(query, [channel.port2]);
		} catch {
			// A client that went away between listing and asking.
			done(null);
		}
	});
}

/** Answers a build query on the port it came with. */
export function answerBuild(port: MessagePort | undefined, entry: string): void {
	const reply: BuildReply = { type: BUILD_REPLY, entry };
	port?.postMessage(reply);
}
