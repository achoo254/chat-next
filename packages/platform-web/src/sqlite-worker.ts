// Web worker entry (ADR 0007): transport, sync engine, SQLite on OPFS and
// local search run here, never on the main thread. One worker per tab; the
// worker whose tab holds the leader lock runs the core, the others proxy
// their tab's calls to it (tab-hub.ts).
import { createConnectTransport } from "@connectrpc/connect-web";
import { createRemoteApi, SessionEndedError, startApp, type ChatCore } from "@app/core";
import { cryptoRandomId, systemTimers, type Platform } from "@app/platform";
import { openMemoryFactory, openSahpoolFactory } from "./driver.ts";
import { LeaderLock } from "./leader.ts";
import { nativeLocks, openLocalDatabase } from "./local-database.ts";
import { cacheBlobStores, canvasImageProbe, fetchHttp } from "./media-platform.ts";
import {
	serializeError,
	type CoreMethod,
	type FromWorker,
	type NativeConnection,
	type ToWorker,
	type WorkerConfig,
} from "./protocol.ts";
import { TabHub, type LeaderCore } from "./tab-hub.ts";
import { RelayedLifecycle, webSocketFactory } from "./worker-platform.ts";

/**
 * The globals this file uses from DedicatedWorkerGlobalScope. The package
 * compiles against the DOM lib (the "WebWorker" lib conflicts with it), so
 * the worker scope is described here instead.
 */
interface WorkerScope {
	postMessage(message: FromWorker): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

function post(message: FromWorker): void {
	scope.postMessage(message);
}

/** Calls a core method by name; the name was checked against CORE_METHODS. */
async function invoke(core: ChatCore, method: CoreMethod, args: unknown[]): Promise<unknown> {
	// The method table is typed per method; the arguments come from this
	// app's own tabs by structured clone, so they are passed through as is.
	const fn = core[method] as (...callArgs: unknown[]) => unknown;
	return fn.apply(core, args);
}

/**
 * The previous leader's OPFS access handles are released when its worker
 * ends, which can trail the lock hand-over slightly; retry the pool a few times.
 */
async function withRetries<T>(run: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (err) {
			if (attempt >= attempts) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}
}

/** Whether this worker has what opfs-sahpool needs (OPFS with sync access handles). */
function opfsAvailable(): boolean {
	return typeof navigator.storage?.getDirectory === "function" && "FileSystemSyncAccessHandle" in globalThis;
}

/** fetch for /rpc: the session cookie on the web, the bearer token (and no cookie) in the native app. */
function rpcFetch(native: NativeConnection | undefined): typeof fetch {
	if (native === undefined) return (input, init) => fetch(input, { ...init, credentials: "same-origin" });
	return (input, init) => {
		const headers = new Headers(init?.headers);
		if (native.sessionToken !== "") headers.set("Authorization", `Bearer ${native.sessionToken}`);
		return fetch(input, { ...init, headers, credentials: "omit" });
	};
}

function startHub(config: WorkerConfig): TabHub {
	const host = location.host;
	const native = config.native;
	const origin = native?.apiOrigin ?? location.origin;
	const lifecycle = new RelayedLifecycle(config.foreground);
	const reportError = (context: string) => (err: unknown) => post({ type: "error", context, message: serializeError(err).message });
	const hub: TabHub = new TabHub({
		tabId: crypto.randomUUID(),
		channel: new BroadcastChannel(`chat-core:${host}`),
		lock: new LeaderLock(native === undefined ? navigator.locks : nativeLocks(navigator.locks), `chat-core-leader:${host}`),
		startLeader: async (): Promise<LeaderCore> => {
			const sql = await openLocalDatabase({
				native: native !== undefined,
				opfsAvailable: opfsAvailable(),
				openPool: () => withRetries(() => openSahpoolFactory(), 5, 300),
				openMemory: openMemoryFactory,
				report: reportError("local database"),
			});
			const api = createRemoteApi(
				createConnectTransport({
					baseUrl: `${origin}/rpc`,
					useBinaryFormat: true,
					fetch: rpcFetch(native),
				}),
			);
			const blobs = cacheBlobStores();
			const platform: Platform = {
				sql,
				lifecycle,
				notify: {
					show: (request) => post({ type: "notify", request }),
					clear: (tag) => post({ type: "notify-clear", tag }),
				},
				socket: webSocketFactory,
				timers: systemTimers,
				// Events cross to the main thread, which batches them per frame.
				frame: (callback) => {
					setTimeout(callback, 0);
				},
				randomId: cryptoRandomId,
				http: fetchHttp,
				imageProbe: canvasImageProbe,
				...(blobs === undefined ? {} : { blobs }),
			};
			const result = await startApp(platform, {
				api,
				realtimeUrl: config.realtimeUrl,
				appVersion: config.appVersion,
				client: native?.client ?? "web",
				// Part of the local database name: the server's host, so data of two servers never mix.
				tenant: new URL(origin).host,
				...(native === undefined ? {} : { sessionToken: native.sessionToken }),
				...(config.userIdHint === undefined ? {} : { userIdHint: config.userIdHint }),
				onSessionEnded: (reason) => hub.broadcastEnded(reason),
				onError: (err, context) => post({ type: "error", context, message: serializeError(err).message }),
			});
			if (result.status === "signed_out") {
				hub.broadcastEnded(result.reason);
				throw new SessionEndedError(`signed out: ${result.reason}`);
			}
			const core = result.core;
			hub.broadcastUser(core.userId);
			return {
				invoke: (method, args) => invoke(core, method, args),
				subscribe: (listener) => core.events.subscribeBatches(listener),
				close: () => core.close(),
			};
		},
		onEvents: (keys) => post({ type: "events", keys }),
		onEnded: (reason) => post({ type: "ended", reason }),
		onRole: (role) => post({ type: "role", role }),
		onUser: (userId) => post({ type: "user", userId }),
		onForeground: (foreground) => lifecycle.setForeground(foreground),
		onOnline: () => lifecycle.reportOnline(),
		onError: (err, context) => post({ type: "error", context, message: serializeError(err).message }),
	});
	hub.start(config.foreground);
	return hub;
}

let hub: TabHub | null = null;

scope.addEventListener("message", (event) => {
	const message = event.data as ToWorker;
	switch (message.type) {
		case "init":
			hub ??= startHub(message.config);
			return;
		case "call": {
			const id = message.id;
			if (hub === null) {
				post({ type: "result", id, ok: false, error: { name: "Error", message: "worker not initialised" } });
				return;
			}
			hub.call(message.method, message.args).then(
				(value) => post({ type: "result", id, ok: true, value }),
				(err: unknown) => post({ type: "result", id, ok: false, error: serializeError(err) }),
			);
			return;
		}
		case "foreground":
			hub?.setForeground(message.foreground);
			return;
		case "online":
			hub?.reportOnline();
			return;
		case "close":
			hub?.close();
			hub = null;
			return;
	}
});
