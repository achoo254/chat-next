// In-memory IntegrationsService for tests and the visual harness: hooks of
// the fixture's chats with the server's rules (admins only, 20 per chat,
// a 7-day grace for the previous secret, turning on needs the creator to
// be an admin, take-over keeps the URL unless rotated), counters, dead
// letters and the audit log. Never imported by production code.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { MemberRole } from "@achoo254/chat-proto/chats";
import {
	IncomingHookAuditAction,
	IncomingHookDisabledReason,
	IncomingHookFormat,
	IncomingHookSchema,
	IncomingHookState,
	IntegrationsService,
	type IncomingHook,
	type IncomingHookAuditEntry,
	type IncomingHookDeadLetter,
	type IncomingHookFailure,
} from "@achoo254/chat-proto/integrations";
import { IncomingHookStopReason } from "@achoo254/chat-proto/messages";
import type { User as WireUser } from "@achoo254/chat-proto/users";

const GRACE_SECONDS = 7 * 86_400;

/** Hook names are trimmed, 1 to 64 code points. */
function validName(raw: string): string {
	const name = raw.trim();
	if (name === "" || [...name].length > 64) throw new ConnectError("name must have 1 to 64 characters", Code.InvalidArgument);
	return name;
}
const HOOKS_MAX = 20;
const SUFFIX: Record<IncomingHookFormat, string> = {
	[IncomingHookFormat.UNSPECIFIED]: "",
	[IncomingHookFormat.NATIVE]: "",
	[IncomingHookFormat.SLACK]: "/slack",
	[IncomingHookFormat.ALERTMANAGER]: "/alertmanager",
	[IncomingHookFormat.GRAFANA]: "/grafana",
	[IncomingHookFormat.GITLAB]: "/gitlab",
};

/** What the fake needs from the chat fixture. */
export interface HookHost {
	readonly selfId: number;
	/** The signed-in user's role in a chat; null when not a member. */
	roleOf(chatId: number): MemberRole | null;
	/** Whether a user (the creator) is still an admin of a chat. */
	isAdmin(chatId: number, userId: number): boolean;
	wireUsers(ids: readonly number[]): WireUser[];
	/** The service message the server posts in a group when a hook stops (actor 0: the server). */
	hookStopped(chatId: number, actorId: number, hookName: string, reason: IncomingHookStopReason): void;
}

export interface HookSeed {
	name: string;
	format?: IncomingHookFormat;
	createdBy?: number;
	state?: IncomingHookState;
	disabledReason?: IncomingHookDisabledReason;
	silent?: boolean;
	allowAlert?: boolean;
	lastUsedAt?: number;
	/** Seconds the previous secret still works; 0 for none. */
	graceLeft?: number;
}

export class FakeIntegrations {
	/** Unix seconds the fake treats as now (hook dates are around it). */
	now = Math.floor(Date.now() / 1000);
	readonly hooks = new Map<string, IncomingHook>();
	/** Current secret per hook; every rotation issues a new one. */
	readonly secrets = new Map<string, string>();
	readonly audit: IncomingHookAuditEntry[] = [];
	readonly deadLetters = new Map<string, IncomingHookDeadLetter[]>();
	readonly counters = new Map<string, { accepted: number; delivered: number; failures: { reason: string; count: number; lastAt: number }[] }>();
	/** Every management call, as "<Method> <hook id or chat id>". */
	readonly calls: string[] = [];
	/** The chat of every hook ever made, deleted ones included (the chat's audit keeps them). */
	private readonly hookChats = new Map<string, number>();
	private nextId = 1;
	private nextAudit = 1;
	private nextSecret = 1;

	constructor(private readonly host: HookHost) {}

	/** Seeds a hook without an audit entry, as if made earlier. */
	seed(chatId: number, seed: HookSeed): string {
		const id = `hk_${String(this.nextId++).padStart(12, "0")}`;
		const createdBy = seed.createdBy ?? this.host.selfId;
		const state = seed.state ?? IncomingHookState.ACTIVE;
		this.hooks.set(
			id,
			create(IncomingHookSchema, {
				id,
				chatId: BigInt(chatId),
				name: seed.name,
				format: seed.format ?? IncomingHookFormat.SLACK,
				allowAlert: seed.allowAlert ?? false,
				silent: seed.silent ?? false,
				createdBy: BigInt(createdBy),
				createdAt: BigInt(this.now - 10 * 86_400),
				state,
				disabledReason: seed.disabledReason ?? (state === IncomingHookState.ACTIVE ? IncomingHookDisabledReason.UNSPECIFIED : IncomingHookDisabledReason.BY_ADMIN),
				disabledAt: BigInt(state === IncomingHookState.ACTIVE ? 0 : this.now - 3600),
				lastUsedAt: BigInt(seed.lastUsedAt ?? 0),
				secretCreatedAt: BigInt(this.now - 86_400),
				secretCreatedBy: BigInt(createdBy),
				previousSecretExpiresAt: BigInt(seed.graceLeft === undefined || seed.graceLeft === 0 ? 0 : this.now + seed.graceLeft),
			}),
		);
		this.secrets.set(id, this.newSecret());
		this.hookChats.set(id, chatId);
		return id;
	}

	/** The URL a hook answers on now (its current secret). */
	urlOf(hookId: string): string {
		const hook = this.find(hookId);
		return `https://chat.example.test/hook/${hookId}/${this.secrets.get(hookId) ?? ""}${SUFFIX[hook.format]}`;
	}

	private newSecret(): string {
		return `S${String(this.nextSecret++).padStart(31, "0")}`;
	}

	private find(hookId: string): IncomingHook {
		const hook = this.hooks.get(hookId);
		if (hook === undefined) throw new ConnectError("hook not found", Code.NotFound);
		return hook;
	}

	/** Admins and the owner manage hooks; other members get permission_denied, outsiders not_found. */
	private requireAdmin(chatId: number): void {
		const role = this.host.roleOf(chatId);
		if (role === null) throw new ConnectError("chat not found", Code.NotFound);
		if (role !== MemberRole.ADMIN && role !== MemberRole.OWNER) throw new ConnectError("admins only", Code.PermissionDenied);
	}

	private adminHook(hookId: string): IncomingHook {
		const hook = this.find(hookId);
		this.requireAdmin(Number(hook.chatId));
		return hook;
	}

	private log(hook: IncomingHook, actorId: number, action: IncomingHookAuditAction, detail = ""): void {
		this.audit.unshift({
			$typeName: "app.v1.IncomingHookAuditEntry",
			id: BigInt(this.nextAudit++),
			date: BigInt(this.now),
			hookId: hook.id,
			hookName: hook.name,
			actorId: BigInt(actorId),
			action,
			detail,
		});
	}

	/** What the server does when a hook's creator loses admin rights. */
	autoDisable(hookId: string, reason = IncomingHookDisabledReason.CREATOR_NOT_ADMIN): void {
		const hook = this.find(hookId);
		hook.state = IncomingHookState.AUTO_DISABLED;
		hook.disabledReason = reason;
		hook.disabledAt = BigInt(this.now);
		const left = reason === IncomingHookDisabledReason.CREATOR_LEFT;
		this.log(hook, 0, IncomingHookAuditAction.AUTO_DISABLED, left ? "creator_left" : "creator_not_admin");
		this.host.hookStopped(
			Number(hook.chatId),
			0,
			hook.name,
			left ? IncomingHookStopReason.CREATOR_LEFT : IncomingHookStopReason.CREATOR_NOT_ADMIN,
		);
	}

	private usersOf(ids: readonly bigint[]): WireUser[] {
		return this.host.wireUsers([...new Set(ids.map(Number))].filter((id) => id !== 0));
	}

	routes(router: ConnectRouter): void {
		const self = this.host.selfId;
		router.service(IntegrationsService, {
			createIncomingHook: (req) => {
				const chatId = Number(req.chatId);
				this.calls.push(`CreateIncomingHook ${chatId}`);
				this.requireAdmin(chatId);
				const name = validName(req.name);
				if (req.format === IncomingHookFormat.UNSPECIFIED) throw new ConnectError("format is required", Code.InvalidArgument);
				const count = [...this.hooks.values()].filter((hook) => Number(hook.chatId) === chatId).length;
				if (count >= HOOKS_MAX) throw new ConnectError(`hooks_limit: a chat has at most ${HOOKS_MAX} webhooks`, Code.FailedPrecondition);
				const id = this.seed(chatId, { name, format: req.format, allowAlert: req.allowAlert, silent: req.silent });
				const hook = this.find(id);
				hook.createdAt = BigInt(this.now);
				hook.secretCreatedAt = BigInt(this.now);
				this.log(hook, self, IncomingHookAuditAction.CREATED, IncomingHookFormat[req.format].toLowerCase());
				return { hook, url: this.urlOf(id) };
			},
			getIncomingHooks: (req) => {
				const chatId = Number(req.chatId);
				this.requireAdmin(chatId);
				const hooks = [...this.hooks.values()].filter((hook) => Number(hook.chatId) === chatId);
				return { hooks, users: this.usersOf(hooks.flatMap((hook) => [hook.createdBy, hook.secretCreatedBy])) };
			},
			getIncomingHook: (req) => {
				const hook = this.adminHook(req.hookId);
				return { hook, users: this.usersOf([hook.createdBy, hook.secretCreatedBy]) };
			},
			rotateIncomingHookSecret: (req) => {
				this.calls.push(`RotateIncomingHookSecret ${req.hookId}${req.revokePrevious ? " revoke" : ""}`);
				const hook = this.adminHook(req.hookId);
				this.secrets.set(hook.id, this.newSecret());
				hook.secretCreatedAt = BigInt(this.now);
				hook.secretCreatedBy = BigInt(self);
				hook.previousSecretExpiresAt = BigInt(req.revokePrevious ? 0 : this.now + GRACE_SECONDS);
				this.log(hook, self, IncomingHookAuditAction.SECRET_ROTATED, req.revokePrevious ? "previous_revoked" : "");
				return { hook, url: this.urlOf(hook.id) };
			},
			revokePreviousHookSecret: (req) => {
				this.calls.push(`RevokePreviousHookSecret ${req.hookId}`);
				const hook = this.adminHook(req.hookId);
				if (Number(hook.previousSecretExpiresAt) <= this.now) {
					throw new ConnectError("no_previous_secret: the hook has no previous secret in its grace period", Code.FailedPrecondition);
				}
				hook.previousSecretExpiresAt = 0n;
				this.log(hook, self, IncomingHookAuditAction.PREVIOUS_SECRET_REVOKED);
				return { hook };
			},
			setIncomingHookEnabled: (req) => {
				this.calls.push(`SetIncomingHookEnabled ${req.hookId} ${req.enabled ? "on" : "off"}`);
				const hook = this.adminHook(req.hookId);
				if (!req.enabled) {
					if (hook.state === IncomingHookState.ACTIVE) {
						hook.state = IncomingHookState.DISABLED;
						hook.disabledReason = IncomingHookDisabledReason.BY_ADMIN;
						hook.disabledAt = BigInt(this.now);
						this.log(hook, self, IncomingHookAuditAction.DISABLED);
						this.host.hookStopped(Number(hook.chatId), self, hook.name, IncomingHookStopReason.DISABLED);
					}
					return { hook };
				}
				if (hook.state === IncomingHookState.ACTIVE) return { hook };
				if (!this.host.isAdmin(Number(hook.chatId), Number(hook.createdBy))) {
					throw new ConnectError("creator_not_admin: the creator is no longer an admin; take the webhook over instead", Code.FailedPrecondition);
				}
				hook.state = IncomingHookState.ACTIVE;
				hook.disabledReason = IncomingHookDisabledReason.UNSPECIFIED;
				hook.disabledAt = 0n;
				this.log(hook, self, IncomingHookAuditAction.ENABLED);
				return { hook };
			},
			takeOverIncomingHook: (req) => {
				this.calls.push(`TakeOverIncomingHook ${req.hookId}${req.rotateSecret ? " rotate" : ""}`);
				const hook = this.adminHook(req.hookId);
				const previous = Number(hook.createdBy);
				hook.createdBy = BigInt(self);
				hook.state = IncomingHookState.ACTIVE;
				hook.disabledReason = IncomingHookDisabledReason.UNSPECIFIED;
				hook.disabledAt = 0n;
				let url = "";
				if (req.rotateSecret) {
					this.secrets.set(hook.id, this.newSecret());
					hook.secretCreatedAt = BigInt(this.now);
					hook.secretCreatedBy = BigInt(self);
					hook.previousSecretExpiresAt = 0n;
					url = this.urlOf(hook.id);
				}
				this.log(hook, self, IncomingHookAuditAction.TAKEN_OVER, `from user ${previous}`);
				return { hook, url };
			},
			deleteIncomingHook: (req) => {
				this.calls.push(`DeleteIncomingHook ${req.hookId}`);
				const hook = this.adminHook(req.hookId);
				this.log(hook, self, IncomingHookAuditAction.DELETED);
				this.hooks.delete(hook.id);
				this.host.hookStopped(Number(hook.chatId), self, hook.name, IncomingHookStopReason.DELETED);
				return {};
			},
			updateIncomingHook: (req) => {
				this.calls.push(`UpdateIncomingHook ${req.hookId}`);
				const hook = this.adminHook(req.hookId);
				const name = validName(req.name);
				const changes: string[] = [];
				if (name !== hook.name) changes.push(`name (was ${JSON.stringify(hook.name)})`);
				if (req.allowAlert !== hook.allowAlert) changes.push(`allow_alert ${req.allowAlert ? "on" : "off"}`);
				if (req.silent !== hook.silent) changes.push(`silent ${req.silent ? "on" : "off"}`);
				if (changes.length === 0) return { hook };
				hook.name = name;
				hook.allowAlert = req.allowAlert;
				hook.silent = req.silent;
				this.log(hook, self, IncomingHookAuditAction.UPDATED, changes.join(", "));
				return { hook };
			},
			getIncomingHookStats: (req) => {
				this.adminHook(req.hookId);
				const hours = req.hours === 0 ? 24 : req.hours;
				const counters = this.counters.get(req.hookId) ?? { accepted: 0, delivered: 0, failures: [] };
				const failures: IncomingHookFailure[] = counters.failures.map((failure) => ({
					$typeName: "app.v1.IncomingHookFailure",
					reason: failure.reason,
					count: BigInt(failure.count),
					lastAt: BigInt(failure.lastAt),
				}));
				const failed = counters.failures.reduce((sum, failure) => sum + failure.count, 0);
				return { hours, accepted: BigInt(counters.accepted), deliveredRealtime: BigInt(counters.delivered), failed: BigInt(failed), failures };
			},
			getIncomingHookDeadLetters: (req) => {
				this.adminHook(req.hookId);
				const limit = req.limit === 0 ? 50 : req.limit;
				const all = this.deadLetters.get(req.hookId) ?? [];
				const page = all.filter((letter) => req.beforeId === 0n || letter.id < req.beforeId).slice(0, limit);
				return { deadLetters: page };
			},
			getIncomingHookAudit: (req) => {
				this.requireAdmin(Number(req.chatId));
				const limit = req.limit === 0 ? 50 : req.limit;
				const chatId = Number(req.chatId);
				const entries = this.audit
					.filter((entry) => this.hookChats.get(entry.hookId) === chatId && (req.hookId === "" || entry.hookId === req.hookId))
					.filter((entry) => req.beforeId === 0n || entry.id < req.beforeId)
					.slice(0, limit);
				return { entries, users: this.usersOf(entries.map((entry) => entry.actorId)) };
			},
		});
	}

	/** A failed request kept for the admin, newest first. */
	addDeadLetter(hookId: string, reason: string, detail: string, body: string, httpStatus = 400): void {
		const list = this.deadLetters.get(hookId) ?? [];
		const id = BigInt(1000 + list.length + 1);
		list.unshift({
			$typeName: "app.v1.IncomingHookDeadLetter",
			id,
			date: BigInt(this.now - list.length * 60),
			reason,
			detail,
			httpStatus,
			contentType: "application/json",
			body: new TextEncoder().encode(body),
			bodyTruncated: false,
		});
		this.deadLetters.set(hookId, list);
	}

	/** Audit entries made earlier (for the log), oldest first in `actions`. */
	seedAudit(hookId: string, entries: readonly { actorId: number; action: IncomingHookAuditAction; detail?: string; ago: number }[]): void {
		const hook = this.find(hookId);
		for (const entry of entries) {
			this.audit.unshift({
				$typeName: "app.v1.IncomingHookAuditEntry",
				id: BigInt(this.nextAudit++),
				date: BigInt(this.now - entry.ago),
				hookId,
				hookName: hook.name,
				actorId: BigInt(entry.actorId),
				action: entry.action,
				detail: entry.detail ?? "",
			});
		}
	}
}
