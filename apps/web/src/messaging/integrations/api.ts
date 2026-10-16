// Incoming webhooks of a group or channel (IntegrationsService), for its
// admins: what the management screens need, mapped from the wire (ADR 0001:
// int64 arrive as bigint and leave as number). The Connect client and the
// generated schemas load on the first call (client.ts), so the first screen
// does not carry them. A secret URL is only ever returned, never kept here.
import type { Transport } from "@connectrpc/connect";

/** Payload format; it decides the URL suffix. */
export type HookFormat = "native" | "slack" | "alertmanager" | "grafana" | "gitlab";

export const HOOK_FORMATS: readonly HookFormat[] = ["native", "slack", "alertmanager", "grafana", "gitlab"];

/** active; disabled by an admin; auto_disabled by the server when the creator lost admin rights or left. */
export type HookState = "active" | "disabled" | "auto_disabled";

export type HookDisabledReason = "none" | "by_admin" | "creator_not_admin" | "creator_left" | "by_moderator";

export interface Hook {
	/** Public id, part of the URL ("hk_…"). */
	readonly id: string;
	readonly chatId: number;
	/** Shown as "Tích hợp: <name>" on its messages. */
	readonly name: string;
	readonly format: HookFormat;
	/** Payloads may ask for the alert priority lane. */
	readonly allowAlert: boolean;
	/** Every message is posted without a notification. */
	readonly silent: boolean;
	readonly createdBy: number;
	readonly createdAt: number;
	readonly state: HookState;
	readonly disabledReason: HookDisabledReason;
	readonly disabledAt: number;
	/** Last accepted request (unix seconds); 0 when never used. */
	readonly lastUsedAt: number;
	readonly secretCreatedAt: number;
	readonly secretCreatedBy: number;
	/** The previous secret works until then (unix seconds); 0 when there is none. */
	readonly previousSecretExpiresAt: number;
}

/** Names of the users a response mentions (creators, secret issuers, audit actors). */
export type HookNames = ReadonlyMap<number, string>;

export interface HookFailure {
	/** Stable code, see IncomingHookFailure.reason. */
	readonly reason: string;
	readonly count: number;
	readonly lastAt: number;
}

export interface HookStats {
	readonly hours: number;
	readonly accepted: number;
	readonly deliveredRealtime: number;
	readonly failed: number;
	/** Most frequent first. */
	readonly failures: readonly HookFailure[];
}

export interface HookDeadLetter {
	readonly id: number;
	readonly date: number;
	readonly reason: string;
	readonly detail: string;
	readonly httpStatus: number;
	readonly contentType: string;
	/** Request body as received (at most 16 KiB), decoded as UTF-8. */
	readonly body: string;
	readonly bodyTruncated: boolean;
}

export type HookAuditAction =
	| "created"
	| "secret_rotated"
	| "previous_secret_revoked"
	| "disabled"
	| "enabled"
	| "auto_disabled"
	| "taken_over"
	| "deleted"
	| "updated"
	| "unknown";

/** What an "updated" audit entry changed; null for a setting it left alone. */
export interface HookChanges {
	/** The name before (the entry's hookName is the new one). */
	readonly renamedFrom: string | null;
	readonly allowAlert: boolean | null;
	readonly silent: boolean | null;
}

export interface HookAuditEntry {
	readonly id: number;
	readonly date: number;
	readonly hookId: string;
	/** Hook name at the time. */
	readonly hookName: string;
	/** 0 for the server. */
	readonly actorId: number;
	readonly action: HookAuditAction;
	readonly detail: string;
}

/** What an admin can change after creating a hook (the format is fixed by its URL). */
export interface HookSettings {
	readonly name: string;
	readonly allowAlert: boolean;
	readonly silent: boolean;
}

export interface NewHook extends HookSettings {
	readonly format: HookFormat;
}

/** A hook with its full URL, returned once (create, rotate, take over with a new secret). */
export interface HookWithUrl {
	readonly hook: Hook;
	/** "" when the call issued no new secret. */
	readonly url: string;
}

/** Hook names are 1 to 64 characters (code points). */
export const HOOK_NAME_MAX = 64;
/** A chat has at most this many hooks. */
export const HOOKS_PER_CHAT_MAX = 20;
/** The previous secret keeps working this long after a rotation. */
export const GRACE_SECONDS = 7 * 86_400;

export interface Integrations {
	/** Hooks of a chat, oldest first. */
	hooks(chatId: number): Promise<{ hooks: Hook[]; names: HookNames }>;
	hook(hookId: string): Promise<{ hook: Hook; names: HookNames }>;
	/** FailedPrecondition "hooks_limit…" past HOOKS_PER_CHAT_MAX. */
	create(chatId: number, hook: NewHook): Promise<HookWithUrl>;
	/** `revokePrevious` stops the old URL at once instead of after the grace period. */
	rotate(hookId: string, revokePrevious: boolean): Promise<HookWithUrl>;
	/** FailedPrecondition "no_previous_secret…" when no old secret is in its grace period. */
	revokePrevious(hookId: string): Promise<Hook>;
	/** FailedPrecondition "creator_not_admin…" when turning on a hook whose creator is no longer an admin. */
	setEnabled(hookId: string, enabled: boolean): Promise<Hook>;
	/** Makes the caller the creator and turns the hook on; `rotateSecret` returns a new URL. */
	takeOver(hookId: string, rotateSecret: boolean): Promise<HookWithUrl>;
	remove(hookId: string): Promise<void>;
	/** InvalidArgument for a name that is empty or longer than HOOK_NAME_MAX. */
	update(hookId: string, settings: HookSettings): Promise<Hook>;
	stats(hookId: string, hours: number): Promise<HookStats>;
	/** Newest first; `beforeId` 0 for the newest page. */
	deadLetters(hookId: string, beforeId: number, limit: number): Promise<HookDeadLetter[]>;
	/** Every hook of the chat when `hookId` is "", deleted hooks included; newest first. */
	audit(chatId: number, hookId: string, beforeId: number, limit: number): Promise<{ entries: HookAuditEntry[]; names: HookNames }>;
}

/**
 * The integrations calls on `transport`, loading the Connect client on the
 * first call (a failed load is tried again on the next call).
 * `onUnauthenticated` runs when the session is gone; the error is rethrown.
 */
/** The Connect client's code, which the webhook screens' first data waits for; fetched ahead with them. */
export const loadIntegrationsClient = () => import("./client.ts");

export function createIntegrations(transport: Transport, onUnauthenticated: () => void): Integrations {
	let client: Promise<Integrations> | null = null;
	const load = (): Promise<Integrations> => {
		client ??= loadIntegrationsClient()
			.then((module) => module.createIntegrationsClient(transport, onUnauthenticated))
			.catch((err: unknown) => {
				client = null;
				throw err;
			});
		return client;
	};
	return {
		hooks: (chatId) => load().then((api) => api.hooks(chatId)),
		hook: (hookId) => load().then((api) => api.hook(hookId)),
		create: (chatId, hook) => load().then((api) => api.create(chatId, hook)),
		rotate: (hookId, revokePrevious) => load().then((api) => api.rotate(hookId, revokePrevious)),
		revokePrevious: (hookId) => load().then((api) => api.revokePrevious(hookId)),
		setEnabled: (hookId, enabled) => load().then((api) => api.setEnabled(hookId, enabled)),
		takeOver: (hookId, rotateSecret) => load().then((api) => api.takeOver(hookId, rotateSecret)),
		remove: (hookId) => load().then((api) => api.remove(hookId)),
		update: (hookId, settings) => load().then((api) => api.update(hookId, settings)),
		stats: (hookId, hours) => load().then((api) => api.stats(hookId, hours)),
		deadLetters: (hookId, beforeId, limit) => load().then((api) => api.deadLetters(hookId, beforeId, limit)),
		audit: (chatId, hookId, beforeId, limit) => load().then((api) => api.audit(chatId, hookId, beforeId, limit)),
	};
}
