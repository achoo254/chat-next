// Messages between the main thread, its worker and the other tabs' workers.
// Everything crosses postMessage or BroadcastChannel by structured clone;
// all parties are this app on the same origin.
import type { ChatCore, SessionEndReason } from "@app/core";
import type { NotificationRequest } from "@app/platform";

/** ChatCore methods callable from any tab. */
export const CORE_METHODS = [
	"dialogs",
	"history",
	"users",
	"chat",
	"sendText",
	"editText",
	"deleteMessages",
	"markRead",
	"retryOutbox",
	"discardOutbox",
	"search",
	"openChat",
	"snapshot",
	"signOut",
	"connectionState",
	"sessionEnded",
] as const satisfies readonly (keyof ChatCore)[];

export type CoreMethod = (typeof CORE_METHODS)[number];

export function isCoreMethod(value: unknown): value is CoreMethod {
	return typeof value === "string" && (CORE_METHODS as readonly string[]).includes(value);
}

/** A ChatCore seen from another thread: every method is asynchronous. */
export type RemoteCore = {
	[M in CoreMethod]: (...args: Parameters<ChatCore[M]>) => Promise<Awaited<ReturnType<ChatCore[M]>>>;
};

export interface SerializedError {
	readonly name: string;
	readonly message: string;
}

export type CallResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: SerializedError };

export interface WorkerConfig {
	/** WebSocket endpoint of the realtime gateway. */
	readonly realtimeUrl: string;
	readonly appVersion: string;
	/** User of the previous session in this browser; skips GetSelf on warm start. */
	readonly userIdHint?: number;
	readonly foreground: boolean;
}

/** Main thread -> its worker. */
export type ToWorker =
	| { readonly type: "init"; readonly config: WorkerConfig }
	| { readonly type: "call"; readonly id: string; readonly method: CoreMethod; readonly args: unknown[] }
	| { readonly type: "foreground"; readonly foreground: boolean }
	| { readonly type: "online" }
	| { readonly type: "close" };

/** Worker -> its main thread. */
export type FromWorker =
	| ({ readonly type: "result"; readonly id: string } & CallResult)
	| { readonly type: "events"; readonly keys: readonly string[] }
	| { readonly type: "ended"; readonly reason: SessionEndReason }
	| { readonly type: "user"; readonly userId: number }
	| { readonly type: "role"; readonly role: "leader" | "follower" }
	| { readonly type: "notify"; readonly request: NotificationRequest }
	| { readonly type: "notify-clear"; readonly tag: string }
	| { readonly type: "error"; readonly context: string; readonly message: string };

/** Worker <-> worker over BroadcastChannel. */
export type HubMessage =
	| { readonly type: "call"; readonly id: string; readonly method: CoreMethod; readonly args: unknown[] }
	| ({ readonly type: "result"; readonly id: string } & CallResult)
	| { readonly type: "events"; readonly keys: readonly string[] }
	| { readonly type: "leader" }
	| { readonly type: "presence"; readonly tabId: string; readonly foreground: boolean }
	| { readonly type: "online" }
	| { readonly type: "ended"; readonly reason: SessionEndReason }
	| { readonly type: "user"; readonly userId: number };

export function serializeError(err: unknown): SerializedError {
	if (err instanceof Error) return { name: err.name, message: err.message };
	return { name: "Error", message: String(err) };
}

/** Rebuilds an error from another thread, keeping its name for instanceof-free checks. */
export function deserializeError(error: SerializedError): Error {
	const rebuilt = new Error(error.message);
	rebuilt.name = error.name;
	return rebuilt;
}
