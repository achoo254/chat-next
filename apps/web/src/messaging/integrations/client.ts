// Connect implementation of Integrations (see api.ts), loaded on first use.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@app/core";
import {
	IncomingHookAuditAction as WireAction,
	IncomingHookDisabledReason as WireReason,
	IncomingHookFormat as WireFormat,
	IncomingHookState as WireState,
	IntegrationsService,
	type IncomingHook,
	type IncomingHookAuditEntry,
	type IncomingHookDeadLetter,
} from "@app/proto-ts/integrations";
import type { User as WireUser } from "@app/proto-ts/users";
import type { Hook, HookAuditAction, HookAuditEntry, HookDeadLetter, HookDisabledReason, HookFormat, HookNames, HookState, Integrations } from "./api.ts";

const FORMATS: Partial<Record<WireFormat, HookFormat>> = {
	[WireFormat.NATIVE]: "native",
	[WireFormat.SLACK]: "slack",
	[WireFormat.ALERTMANAGER]: "alertmanager",
	[WireFormat.GRAFANA]: "grafana",
	[WireFormat.GITLAB]: "gitlab",
};

const WIRE_FORMATS: Record<HookFormat, WireFormat> = {
	native: WireFormat.NATIVE,
	slack: WireFormat.SLACK,
	alertmanager: WireFormat.ALERTMANAGER,
	grafana: WireFormat.GRAFANA,
	gitlab: WireFormat.GITLAB,
};

const STATES: Partial<Record<WireState, HookState>> = {
	[WireState.ACTIVE]: "active",
	[WireState.DISABLED]: "disabled",
	[WireState.AUTO_DISABLED]: "auto_disabled",
};

const REASONS: Partial<Record<WireReason, HookDisabledReason>> = {
	[WireReason.BY_ADMIN]: "by_admin",
	[WireReason.CREATOR_NOT_ADMIN]: "creator_not_admin",
	[WireReason.CREATOR_LEFT]: "creator_left",
};

const ACTIONS: Partial<Record<WireAction, HookAuditAction>> = {
	[WireAction.CREATED]: "created",
	[WireAction.SECRET_ROTATED]: "secret_rotated",
	[WireAction.PREVIOUS_SECRET_REVOKED]: "previous_secret_revoked",
	[WireAction.DISABLED]: "disabled",
	[WireAction.ENABLED]: "enabled",
	[WireAction.AUTO_DISABLED]: "auto_disabled",
	[WireAction.TAKEN_OVER]: "taken_over",
	[WireAction.DELETED]: "deleted",
};

/** A hook in a state this client does not know is shown as turned off (requests may be refused). */
export function toHook(hook: IncomingHook): Hook {
	return {
		id: hook.id,
		chatId: assertSafeId(hook.chatId),
		name: hook.name,
		format: FORMATS[hook.format] ?? "native",
		allowAlert: hook.allowAlert,
		silent: hook.silent,
		createdBy: assertSafeId(hook.createdBy),
		createdAt: assertSafeId(hook.createdAt),
		state: STATES[hook.state] ?? "disabled",
		disabledReason: REASONS[hook.disabledReason] ?? "none",
		disabledAt: assertSafeId(hook.disabledAt),
		lastUsedAt: assertSafeId(hook.lastUsedAt),
		secretCreatedAt: assertSafeId(hook.secretCreatedAt),
		secretCreatedBy: assertSafeId(hook.secretCreatedBy),
		previousSecretExpiresAt: assertSafeId(hook.previousSecretExpiresAt),
	};
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

function toDeadLetter(entry: IncomingHookDeadLetter): HookDeadLetter {
	return {
		id: assertSafeId(entry.id),
		date: assertSafeId(entry.date),
		reason: entry.reason,
		detail: entry.detail,
		httpStatus: entry.httpStatus,
		contentType: entry.contentType,
		body: utf8.decode(entry.body),
		bodyTruncated: entry.bodyTruncated,
	};
}

function toAuditEntry(entry: IncomingHookAuditEntry): HookAuditEntry {
	return {
		id: assertSafeId(entry.id),
		date: assertSafeId(entry.date),
		hookId: entry.hookId,
		hookName: entry.hookName,
		actorId: assertSafeId(entry.actorId),
		action: ACTIONS[entry.action] ?? "unknown",
		detail: entry.detail,
	};
}

function namesOf(users: readonly WireUser[]): HookNames {
	return new Map(users.map((user) => [assertSafeId(user.id), user.name]));
}

function requireHook(hook: IncomingHook | undefined, method: string): Hook {
	if (hook === undefined) throw new ConnectError(`${method} returned no hook`, Code.Internal);
	return toHook(hook);
}

export function createIntegrationsClient(transport: Transport, onUnauthenticated: () => void): Integrations {
	const service = createClient(IntegrationsService, transport);

	async function call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			if (ConnectError.from(err).code === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	}

	return {
		hooks: (chatId) =>
			call(async () => {
				const response = await service.getIncomingHooks({ chatId: BigInt(chatId) });
				return { hooks: response.hooks.map(toHook), names: namesOf(response.users) };
			}),
		hook: (hookId) =>
			call(async () => {
				const response = await service.getIncomingHook({ hookId });
				return { hook: requireHook(response.hook, "GetIncomingHook"), names: namesOf(response.users) };
			}),
		create: (chatId, hook) =>
			call(async () => {
				const response = await service.createIncomingHook({
					chatId: BigInt(chatId),
					name: hook.name,
					format: WIRE_FORMATS[hook.format],
					allowAlert: hook.allowAlert,
					silent: hook.silent,
				});
				return { hook: requireHook(response.hook, "CreateIncomingHook"), url: response.url };
			}),
		rotate: (hookId, revokePrevious) =>
			call(async () => {
				const response = await service.rotateIncomingHookSecret({ hookId, revokePrevious });
				return { hook: requireHook(response.hook, "RotateIncomingHookSecret"), url: response.url };
			}),
		revokePrevious: (hookId) =>
			call(async () => requireHook((await service.revokePreviousHookSecret({ hookId })).hook, "RevokePreviousHookSecret")),
		setEnabled: (hookId, enabled) =>
			call(async () => requireHook((await service.setIncomingHookEnabled({ hookId, enabled })).hook, "SetIncomingHookEnabled")),
		takeOver: (hookId, rotateSecret) =>
			call(async () => {
				const response = await service.takeOverIncomingHook({ hookId, rotateSecret });
				return { hook: requireHook(response.hook, "TakeOverIncomingHook"), url: response.url };
			}),
		remove: (hookId) =>
			call(async () => {
				await service.deleteIncomingHook({ hookId });
			}),
		stats: (hookId, hours) =>
			call(async () => {
				const response = await service.getIncomingHookStats({ hookId, hours });
				return {
					hours: response.hours,
					accepted: assertSafeId(response.accepted),
					deliveredRealtime: assertSafeId(response.deliveredRealtime),
					failed: assertSafeId(response.failed),
					failures: response.failures.map((failure) => ({
						reason: failure.reason,
						count: assertSafeId(failure.count),
						lastAt: assertSafeId(failure.lastAt),
					})),
				};
			}),
		deadLetters: (hookId, beforeId, limit) =>
			call(async () => {
				const response = await service.getIncomingHookDeadLetters({ hookId, beforeId: BigInt(beforeId), limit });
				return response.deadLetters.map(toDeadLetter);
			}),
		audit: (chatId, hookId, beforeId, limit) =>
			call(async () => {
				const response = await service.getIncomingHookAudit({ chatId: BigInt(chatId), hookId, beforeId: BigInt(beforeId), limit });
				return { entries: response.entries.map(toAuditEntry), names: namesOf(response.users) };
			}),
	};
}
