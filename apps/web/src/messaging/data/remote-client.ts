// Connect implementation of Remote (see remote.ts), with the protocol
// mapping (ADR 0001: every int64 arrives as a bigint and leaves as a number).
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId, fromWireEntity } from "@app/core";
import { cryptoRandomId } from "@app/platform";
import {
	AddMemberFailureReason,
	ChatsService,
	ChatType,
	HistoryVisibility,
	MemberRole as WireRole,
	type AddMemberFailure,
	type Chat as WireChat,
	type ChatMember,
	type ForumTopic,
	type InviteLink,
} from "@app/proto-ts/chats";
import { ConfigService } from "@app/proto-ts/config";
import { MessagesService } from "@app/proto-ts/messages";
import {
	FeedbackKind as WireFeedbackKind,
	FeedbackStatus as WireFeedbackStatus,
	ModerationAction as WireAction,
	ModerationService,
	AnnouncementState as WireAnnouncementState,
	type Announcement as WireAnnouncement,
	type Feedback as WireFeedback,
	ReportStatus as WireStatus,
	ReportTargetKind,
	type BotReview as WireBotReview,
	type ModerationLogEntry,
	type Report as WireReport,
} from "@app/proto-ts/moderation";
import { BotTier } from "@app/proto-ts/bot_admin";
import {
	PrivacyAudience,
	ReportReason as WireReason,
	UsersService,
	UserStatusKind,
	type PrivacySettings,
	type User as WireUser,
} from "@app/proto-ts/users";
import type { ReportReason } from "./pending-backend.ts";
import type {
	Announcement,
	AnnouncementState,
	AddFailure,
	AddFailureReason,
	Audience,
	ChatBrief,
	FeedbackItem,
	FeedbackStatus,
	Invite,
	Limits,
	Member,
	BotReview,
	BotTierName,
	ModerationAction,
	ModerationEntry,
	ModerationLogFilter,
	ModerationReport,
	ReportKind,
	Person,
	Presence,
	Privacy,
	Remote,
	ReportStatus,
	Role,
	ServerTopic,
} from "./remote.ts";

const TOPICS_PAGE = 100;
const CONTACTS_PAGE = 500;
const BANNED_PAGE = 100;
const BLOCKED_PAGE = 200;
const REACTIONS_PAGE = 100;
const COMMON_PAGE = 100;
const REPORTS_PAGE = 100;
const FEEDBACK_PAGE = 100;
const LOG_PAGE = 100;
/** SetDialogMute takes at most 366 days; longer means until turned back on. */
const MUTE_MAX_SECONDS = 31_622_400;

const AUDIENCES: Record<PrivacyAudience, Audience> = {
	[PrivacyAudience.UNSPECIFIED]: "nobody",
	[PrivacyAudience.EVERYONE]: "everyone",
	[PrivacyAudience.CONTACTS]: "contacts",
	[PrivacyAudience.NOBODY]: "nobody",
};

const WIRE_AUDIENCES: Record<Audience, PrivacyAudience> = {
	everyone: PrivacyAudience.EVERYONE,
	contacts: PrivacyAudience.CONTACTS,
	nobody: PrivacyAudience.NOBODY,
};

const ROLES: Record<WireRole, Role> = {
	[WireRole.UNSPECIFIED]: "member",
	[WireRole.MEMBER]: "member",
	[WireRole.ADMIN]: "admin",
	[WireRole.OWNER]: "owner",
};

function presenceOf(user: WireUser): Presence {
	switch (user.status?.kind) {
		case UserStatusKind.ONLINE:
			return { kind: "online" };
		case UserStatusKind.OFFLINE:
			return { kind: "offline", lastSeen: assertSafeId(user.status.lastSeen) };
		case UserStatusKind.RECENTLY:
			return { kind: "recently" };
		case UserStatusKind.LAST_WEEK:
			return { kind: "last_week" };
		case UserStatusKind.LAST_MONTH:
			return { kind: "last_month" };
		default:
			return { kind: "hidden" };
	}
}

export function toPerson(user: WireUser): Person {
	return {
		id: assertSafeId(user.id),
		name: user.name,
		username: user.username,
		bio: user.bio,
		isBot: user.isBot,
		isSelf: user.isSelf,
		isBlocked: user.isBlocked,
		presence: presenceOf(user),
		...(user.photo !== undefined && user.photo.fileId !== "" ? { photoId: user.photo.fileId } : {}),
	};
}

export function toInvite(invite: InviteLink): Invite {
	return {
		link: invite.link,
		expiresAt: assertSafeId(invite.expiresAt),
		usageLimit: invite.usageLimit,
		usageCount: invite.usageCount,
		revoked: invite.revoked,
	};
}

export function toPrivacy(settings: PrivacySettings | undefined): Privacy {
	if (settings === undefined) throw new ConnectError("privacy settings missing", Code.Internal);
	return {
		lastSeen: AUDIENCES[settings.lastSeen] ?? "nobody",
		profilePhoto: AUDIENCES[settings.profilePhoto] ?? "nobody",
		findByEmail: AUDIENCES[settings.findByEmail] ?? "nobody",
		findByUsername: AUDIENCES[settings.findByUsername] ?? "nobody",
		addToGroups: AUDIENCES[settings.addToGroups] ?? "nobody",
		sendMessages: AUDIENCES[settings.sendMessages] ?? "nobody",
		notificationPreview: settings.notificationPreview,
	};
}

/** The report reasons of the mock (settings.html#report) on the wire. */
const REPORT_REASONS: Record<ReportReason, WireReason> = {
	spam: WireReason.SPAM,
	scam: WireReason.SCAM,
	violence: WireReason.VIOLENCE,
	sexual: WireReason.SEXUAL,
	other: WireReason.OTHER,
};

const WIRE_REASONS: Partial<Record<WireReason, ReportReason>> = {
	[WireReason.SPAM]: "spam",
	[WireReason.SCAM]: "scam",
	[WireReason.VIOLENCE]: "violence",
	[WireReason.SEXUAL]: "sexual",
};

const FAILURE_REASONS: Record<AddMemberFailureReason, AddFailureReason> = {
	[AddMemberFailureReason.UNSPECIFIED]: "privacy",
	[AddMemberFailureReason.NOT_FOUND]: "not_found",
	[AddMemberFailureReason.PRIVACY_ADD_TO_GROUPS]: "privacy",
	[AddMemberFailureReason.BLOCKED]: "blocked",
	[AddMemberFailureReason.BANNED]: "banned",
	[AddMemberFailureReason.ALREADY_MEMBER]: "already_member",
	[AddMemberFailureReason.TOO_MANY]: "too_many",
};

/**
 * Every user the server did not add. Servers before per-person reasons send
 * failed_user_ids only: those count as refused by privacy.
 */
function toFailures(failures: readonly AddMemberFailure[], failedUserIds: readonly bigint[]): AddFailure[] {
	if (failures.length > 0) {
		return failures.map((failure) => ({ userId: assertSafeId(failure.userId), reason: FAILURE_REASONS[failure.reason] ?? "privacy" }));
	}
	return failedUserIds.map((id) => ({ userId: assertSafeId(id), reason: "privacy" }));
}

const STATUSES: Record<WireStatus, ReportStatus> = {
	[WireStatus.UNSPECIFIED]: "open",
	[WireStatus.OPEN]: "open",
	[WireStatus.RESOLVED]: "resolved",
	[WireStatus.DISMISSED]: "dismissed",
};

const WIRE_STATUSES: Record<ReportStatus, WireStatus> = {
	open: WireStatus.OPEN,
	resolved: WireStatus.RESOLVED,
	dismissed: WireStatus.DISMISSED,
};

const WIRE_ACTIONS: Record<ModerationAction, WireAction> = {
	dismiss: WireAction.DISMISS,
	delete_messages: WireAction.DELETE_MESSAGES,
	ban_from_chat: WireAction.BAN_FROM_CHAT,
	restrict_account: WireAction.RESTRICT_ACCOUNT,
	warn: WireAction.WARN,
	disable_webhook: WireAction.DISABLE_WEBHOOK,
	lift_restriction: WireAction.LIFT_RESTRICTION,
	restrict_bot: WireAction.RESTRICT_BOT,
	restore_bot_tier: WireAction.RESTORE_BOT_TIER,
	keep_bot_restricted: WireAction.KEEP_BOT_RESTRICTED,
	verify_bot: WireAction.VERIFY_BOT,
	unverify_bot: WireAction.UNVERIFY_BOT,
	limit_stranger_chats: WireAction.LIMIT_STRANGER_CHATS,
};

const ACTIONS = new Map<WireAction, ModerationAction>(
	(Object.entries(WIRE_ACTIONS) as [ModerationAction, WireAction][]).map(([action, wire]) => [wire, action]),
);

const KINDS: Partial<Record<ReportTargetKind, ReportKind>> = {
	[ReportTargetKind.USER]: "user",
	[ReportTargetKind.BOT]: "bot",
	[ReportTargetKind.CHAT]: "chat",
	[ReportTargetKind.MESSAGES]: "messages",
	[ReportTargetKind.WEBHOOK]: "webhook",
};

const TIERS: Partial<Record<BotTier, BotTierName>> = {
	[BotTier.NEW]: "new",
	[BotTier.DEFAULT]: "default",
	[BotTier.VERIFIED]: "verified",
	[BotTier.INTERNAL]: "internal",
	[BotTier.RESTRICTED]: "restricted",
};

function toBotReview(review: WireBotReview): BotReview {
	return {
		botId: assertSafeId(review.botId),
		ownerId: assertSafeId(review.ownerId),
		createdAt: assertSafeId(review.createdAt),
		tier: TIERS[review.tier] ?? "default",
		verified: review.verified,
		restrictedAt: assertSafeId(review.restrictedAt),
		restrictedReason: review.restrictedReason,
		restrictedAutomatically: review.restrictedAutomatically,
		restrictionReviewed: review.restrictionReviewed,
		users: review.users,
		messages7d: review.messages7d,
		blockedPermille24h: review.blockedPermille24h,
		openReports: review.openReports,
	};
}

function toActions(actions: readonly WireAction[]): ModerationAction[] {
	return actions.flatMap((action) => {
		const mapped = ACTIONS.get(action);
		return mapped === undefined ? [] : [mapped];
	});
}

function toReport(report: WireReport): ModerationReport {
	return {
		id: assertSafeId(report.id),
		kind: KINDS[report.targetKind] ?? "messages",
		reporterId: assertSafeId(report.reporterId),
		targetUserId: assertSafeId(report.targetUserId),
		targetChatId: assertSafeId(report.targetChatId),
		seqs: report.seqs.map(assertSafeId),
		reason: WIRE_REASONS[report.reason] ?? "other",
		comment: report.comment,
		status: STATUSES[report.status] ?? "open",
		createdAt: assertSafeId(report.createdAt),
		resolvedAt: assertSafeId(report.resolvedAt),
		resolvedBy: assertSafeId(report.resolvedBy),
		actions: toActions(report.actions),
		resolutionNote: report.resolutionNote,
	};
}

const WIRE_FEEDBACK_STATUSES: Record<FeedbackStatus, WireFeedbackStatus> = {
	open: WireFeedbackStatus.OPEN,
	handled: WireFeedbackStatus.HANDLED,
};

const ANNOUNCEMENT_STATES: Partial<Record<WireAnnouncementState, AnnouncementState>> = {
	[WireAnnouncementState.QUEUED]: "queued",
	[WireAnnouncementState.RUNNING]: "running",
	[WireAnnouncementState.DONE]: "done",
	[WireAnnouncementState.CANCELLED]: "cancelled",
};

function toAnnouncement(a: WireAnnouncement | undefined, method: string): Announcement {
	if (a === undefined) throw new ConnectError(`${method} returned no announcement`, Code.Internal);
	return {
		id: assertSafeId(a.id),
		text: a.text,
		entities: a.entities.map(fromWireEntity),
		state: ANNOUNCEMENT_STATES[a.state] ?? "queued",
		reason: a.reason,
		total: a.total,
		sent: a.sent,
		skipped: a.skipped,
		failed: a.failed,
		createdAt: assertSafeId(a.createdAt),
		finishedAt: assertSafeId(a.finishedAt),
		createdBy: assertSafeId(a.createdBy),
	};
}

function toFeedback(item: WireFeedback): FeedbackItem {
	return {
		id: assertSafeId(item.id),
		userId: assertSafeId(item.userId),
		kind: item.kind === WireFeedbackKind.BUG ? "bug" : "idea",
		text: item.text,
		status: item.status === WireFeedbackStatus.HANDLED ? "handled" : "open",
		createdAt: assertSafeId(item.createdAt),
		handledAt: assertSafeId(item.handledAt),
		handledBy: assertSafeId(item.handledBy),
		replyText: item.replyText,
		repliedAt: assertSafeId(item.repliedAt),
		repliedBy: assertSafeId(item.repliedBy),
	};
}

/** A log entry; null for an action this client does not know (newer server). */
function toEntry(entry: ModerationLogEntry): ModerationEntry | null {
	const action = ACTIONS.get(entry.action);
	if (action === undefined) return null;
	return {
		id: assertSafeId(entry.id),
		operatorId: assertSafeId(entry.operatorId),
		reportId: assertSafeId(entry.reportId),
		action,
		targetUserId: assertSafeId(entry.targetUserId),
		targetChatId: assertSafeId(entry.targetChatId),
		seqs: entry.seqs.map(assertSafeId),
		hookId: entry.hookId,
		note: entry.note,
		until: assertSafeId(entry.until),
		createdAt: assertSafeId(entry.createdAt),
	};
}

function knownEntries(entries: readonly ModerationLogEntry[]): ModerationEntry[] {
	return entries.flatMap((entry) => {
		const mapped = toEntry(entry);
		return mapped === null ? [] : [mapped];
	});
}

function toChatBrief(chat: WireChat): ChatBrief {
	return { id: assertSafeId(chat.id), title: chat.title, channel: chat.type === ChatType.CHANNEL, memberCount: chat.memberCount };
}

function peopleOf(users: readonly WireUser[]): Map<number, Person> {
	return new Map(users.map((user) => [assertSafeId(user.id), toPerson(user)]));
}

const HISTORY: Partial<Record<HistoryVisibility, boolean>> = {
	[HistoryVisibility.SHARED]: true,
	[HistoryVisibility.SINCE_JOIN]: false,
};

function toTopic(topic: ForumTopic): ServerTopic {
	return {
		id: assertSafeId(topic.id),
		title: topic.title,
		iconColor: topic.iconColor,
		creatorId: assertSafeId(topic.creatorId),
		createdAt: assertSafeId(topic.createdAt),
		pinned: topic.pinned,
		closed: topic.closed,
		hidden: topic.hidden,
		topSeq: assertSafeId(topic.topSeq),
		readInboxMaxSeq: assertSafeId(topic.readInboxMaxSeq),
		unreadCount: topic.unreadCount,
		icon: topic.icon,
		messageCount: topic.messageCount,
		unreadMentions: topic.unreadMentionsCount,
	};
}

function toMember(member: ChatMember, people: ReadonlyMap<number, Person>): Member | null {
	const userId = assertSafeId(member.userId);
	const person = people.get(userId);
	if (person === undefined) return null;
	return {
		person,
		role: ROLES[member.role] ?? "member",
		permissions: member.permissions,
		inviterId: assertSafeId(member.inviterId),
		joinedAt: assertSafeId(member.joinedAt),
	};
}

function requireChatId(chat: { id: bigint } | undefined, method: string): number {
	if (chat === undefined) throw new ConnectError(`${method} returned no chat`, Code.Internal);
	return assertSafeId(chat.id);
}

/** The Connect implementation behind createRemote (loaded on first use). */
export function createRemoteClient(transport: Transport, onUnauthenticated: () => void): Remote {
	const chats = createClient(ChatsService, transport);
	const messages = createClient(MessagesService, transport);
	const users = createClient(UsersService, transport);
	const config = createClient(ConfigService, transport);
	const moderation = createClient(ModerationService, transport);
	let limits: Promise<Limits> | null = null;

	async function call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			if (ConnectError.from(err).code === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	}

	return {
		limits: () => {
			limits ??= call(async () => {
				const response = await config.getAppConfig({});
				if (response.result.case !== "config") {
					return { messageLengthMax: 0, editTimeLimit: 0, readReceiptsMemberMax: 0, readReceiptsMaxAge: 0 };
				}
				const app = response.result.value;
				return {
					messageLengthMax: app.messageLengthMax,
					editTimeLimit: app.editTimeLimitSeconds,
					readReceiptsMemberMax: app.readReceiptsMemberMax,
					readReceiptsMaxAge: app.readReceiptsMaxAgeSeconds,
				};
			}).catch((err: unknown) => {
				limits = null;
				throw err;
			});
			return limits;
		},
		setReaction: (chatId, seq, emoji) =>
			call(async () => {
				await messages.setReaction({ chatId: BigInt(chatId), seq: BigInt(seq), emoji });
			}),
		pin: (chatId, seq, notify = true) =>
			call(async () => {
				await messages.pinMessage({ chatId: BigInt(chatId), seq: BigInt(seq), silent: !notify });
			}),
		unpin: (chatId, seq) =>
			call(async () => {
				await messages.unpinMessage({ chatId: BigInt(chatId), seq: BigInt(seq) });
			}),
		forward: (fromChatId, seqs, toChatId) =>
			call(async () => {
				await messages.forwardMessages({
					fromChatId: BigInt(fromChatId),
					seqs: seqs.map(BigInt),
					toChatId: BigInt(toChatId),
					randomIds: seqs.map(() => BigInt(cryptoRandomId())),
				});
			}),
		createPrivate: (userId) =>
			call(async () => requireChatId((await chats.createPrivate({ userId: BigInt(userId) })).chat, "CreatePrivate")),
		createGroup: (title, userIds, forum = false) =>
			call(async () => {
				const response = await chats.createGroup({ title, userIds: userIds.map(BigInt), forum });
				return {
					chatId: requireChatId(response.chat, "CreateGroup"),
					failures: toFailures(response.failures, response.failedUserIds),
				};
			}),
		createChannel: (title, about) =>
			call(async () => requireChatId((await chats.createChannel({ title, about })).chat, "CreateChannel")),
		members: (chatId, query = "", cursor = "") =>
			call(async () => {
				const response = await chats.getMembers({ chatId: BigInt(chatId), query, cursor, limit: 50 });
				const people = new Map(response.users.map((user) => [assertSafeId(user.id), toPerson(user)]));
				const members = response.members.flatMap((member) => {
					const mapped = toMember(member, people);
					return mapped === null ? [] : [mapped];
				});
				return { members, nextCursor: response.nextCursor };
			}),
		addMembers: (chatId, userIds) =>
			call(async () => {
				const response = await chats.addMembers({ chatId: BigInt(chatId), userIds: userIds.map(BigInt) });
				return toFailures(response.failures, response.failedUserIds);
			}),
		removeMember: (chatId, userId, ban) =>
			call(async () => {
				await chats.removeMember({ chatId: BigInt(chatId), userId: BigInt(userId), ban });
			}),
		unbanMember: (chatId, userId) =>
			call(async () => {
				await chats.unbanMember({ chatId: BigInt(chatId), userId: BigInt(userId) });
			}),
		bannedMembers: (chatId, cursor = "") =>
			call(async () => {
				const response = await chats.getBannedMembers({ chatId: BigInt(chatId), cursor, limit: BANNED_PAGE });
				const people = new Map(response.users.map((user) => [assertSafeId(user.id), toPerson(user)]));
				const items = response.members.flatMap((member) => {
					const person = people.get(assertSafeId(member.userId));
					return person === undefined
						? []
						: [
								{
									person,
									bannedBy: assertSafeId(member.bannedBy),
									bannedByName: people.get(assertSafeId(member.bannedBy))?.name ?? "",
									bannedAt: assertSafeId(member.bannedAt),
								},
							];
				});
				return { items, nextCursor: response.nextCursor };
			}),
		leaveChat: (chatId, newOwnerId = 0) =>
			call(async () => {
				await chats.leaveChat({ chatId: BigInt(chatId), newOwnerId: BigInt(newOwnerId) });
			}),
		setAdmin: (chatId, userId, admin) =>
			call(async () => {
				await chats.setAdmin({ chatId: BigInt(chatId), userId: BigInt(userId), admin });
			}),
		setDefaultPermissions: (chatId, permissions) =>
			call(async () => {
				await chats.updateChatInfo({ chatId: BigInt(chatId), defaultPermissions: permissions });
			}),
		updateChatInfo: (chatId, changes) =>
			call(async () => {
				await chats.updateChatInfo({ chatId: BigInt(chatId), ...changes });
			}),
		setHistoryShared: (chatId, shared) =>
			call(async () => {
				await chats.setHistoryVisibility({
					chatId: BigInt(chatId),
					historyVisibility: shared ? HistoryVisibility.SHARED : HistoryVisibility.SINCE_JOIN,
				});
			}),
		enableTopics: (chatId) =>
			call(async () => {
				await chats.updateChatInfo({ chatId: BigInt(chatId), forum: true });
			}),
		exportInvite: (chatId, expiresAt, usageLimit) =>
			call(async () => {
				const response = await chats.exportInviteLink({
					chatId: BigInt(chatId),
					expiresAt: BigInt(expiresAt),
					usageLimit,
				});
				if (response.invite === undefined) throw new ConnectError("ExportInviteLink returned no link", Code.Internal);
				return toInvite(response.invite);
			}),
		joinByInvite: (link) =>
			call(async () => requireChatId((await chats.joinByInvite({ link })).chat, "JoinByInvite")),
		searchPeople: (query) =>
			call(async () => (await users.searchUsers({ query, limit: 20 })).users.map(toPerson)),
		people: (ids) =>
			call(async () =>
				ids.length === 0 ? [] : (await users.getUsers({ userIds: ids.map(BigInt) })).users.map(toPerson),
			),
		block: (userId) =>
			call(async () => {
				await users.block({ userId: BigInt(userId) });
			}),
		unblock: (userId) =>
			call(async () => {
				await users.unblock({ userId: BigInt(userId) });
			}),
		privacy: () => call(async () => toPrivacy((await users.getPrivacy({})).settings)),
		contacts: (cursor = "") =>
			call(async () => {
				const response = await users.getContacts({ cursor, limit: CONTACTS_PAGE });
				const added = new Map(response.contacts.map((contact) => [assertSafeId(contact.userId), assertSafeId(contact.addedAt)]));
				const items = response.users.map((user) => {
					const person = toPerson(user);
					return { person, addedAt: added.get(person.id) ?? 0 };
				});
				return { items, nextCursor: response.nextCursor };
			}),
		addContact: (target) =>
			call(async () => {
				const wire =
					"userId" in target
						? { case: "userId" as const, value: BigInt(target.userId) }
						: "username" in target
							? { case: "username" as const, value: target.username }
							: { case: "email" as const, value: target.email };
				const user = (await users.addContact({ target: wire })).user;
				if (user === undefined) throw new ConnectError("AddContact returned no user", Code.Internal);
				return toPerson(user);
			}),
		deleteContact: (userId) =>
			call(async () => {
				await users.deleteContact({ userId: BigInt(userId) });
			}),
		forumTopics: (chatId, cursor = "") =>
			call(async () => {
				const response = await chats.getForumTopics({ chatId: BigInt(chatId), cursor, limit: TOPICS_PAGE });
				return {
					topics: response.topics.map(toTopic),
					tops: response.messages.map((m) => ({
						seq: assertSafeId(m.seq),
						fromId: assertSafeId(m.fromId),
						text: m.text,
						date: assertSafeId(m.date),
					})),
					nextCursor: response.nextCursor,
				};
			}),
		pinTopic: (chatId, topicId, pinned) =>
			call(async () => {
				await chats.editForumTopic({ chatId: BigInt(chatId), topicId: BigInt(topicId), pinned });
			}),
		closeTopic: (chatId, topicId, closed) =>
			call(async () => {
				await chats.closeForumTopic({ chatId: BigInt(chatId), topicId: BigInt(topicId), closed });
			}),
		hideTopic: (chatId, topicId, hidden) =>
			call(async () => {
				await chats.hideForumTopic({ chatId: BigInt(chatId), topicId: BigInt(topicId), hidden });
			}),
		sendToTopic: (chatId, topicId, text, replyToSeq, noLinkPreview = false) =>
			call(async () => {
				await messages.sendMessage({
					chatId: BigInt(chatId),
					text,
					replyToSeq: BigInt(replyToSeq),
					topicId: BigInt(topicId),
					randomId: BigInt(cryptoRandomId()),
					noLinkPreview,
				});
			}),
		readTopic: (chatId, topicId, maxSeq) =>
			call(async () => {
				await messages.readHistory({ chatId: BigInt(chatId), maxSeq: BigInt(maxSeq), topicId: BigInt(topicId) });
			}),
		linkPreview: (url) =>
			call(async () => {
				const preview = (await messages.getLinkPreview({ url })).preview;
				if (preview === undefined || preview.title === "") return null;
				return { url: preview.url, siteName: preview.siteName, title: preview.title, description: preview.description };
			}),
		report: (target, reason, comment) =>
			call(async () => {
				const wireTarget =
					target.kind === "user"
						? { case: "userId" as const, value: BigInt(target.userId) }
						: target.kind === "chat"
							? { case: "chatId" as const, value: BigInt(target.chatId) }
							: { case: "messages" as const, value: { chatId: BigInt(target.chatId), seqs: [BigInt(target.seq)] } };
				await users.report({ target: wireTarget, reason: REPORT_REASONS[reason], comment });
			}),
		checkInvite: (link) =>
			call(async () => {
				const response = await chats.checkInvite({ link });
				return {
					title: response.title,
					about: response.about,
					kind: response.type === ChatType.CHANNEL ? "channel" : response.type === ChatType.GROUP ? "group" : "other",
					memberCount: response.memberCount,
					memberOfChatId: response.chat === undefined ? 0 : assertSafeId(response.chat.id),
					members: response.users.map(toPerson),
					historyShared: HISTORY[response.historyVisibility] ?? null,
				};
			}),
		inviteLinks: (chatId) => call(async () => (await chats.getInviteLinks({ chatId: BigInt(chatId) })).invites.map(toInvite)),
		revokeInvite: (chatId, link) =>
			call(async () => {
				const response = await chats.revokeInviteLink({ chatId: BigInt(chatId), link });
				if (response.invite === undefined) throw new ConnectError("RevokeInviteLink returned no link", Code.Internal);
				return toInvite(response.invite);
			}),
		readers: (chatId, seq) =>
			call(async () => {
				const response = await messages.getMessageReaders({ chatId: BigInt(chatId), seq: BigInt(seq) });
				const people = new Map(response.users.map((user) => [assertSafeId(user.id), toPerson(user)]));
				// Servers before read dates list user_ids only; keep their order, without a time.
				const read =
					response.readers.length > 0
						? response.readers.map((reader) => ({ userId: assertSafeId(reader.userId), readAt: assertSafeId(reader.readAt) }))
						: response.userIds.map((id) => ({ userId: assertSafeId(id), readAt: 0 }));
				return read.flatMap(({ userId, readAt }) => {
					const person = people.get(userId);
					return person === undefined ? [] : [{ person, readAt }];
				});
			}),
		setDialogMute: (chatId, muteFor) =>
			call(async () => {
				const seconds = muteFor === "forever" ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(muteFor));
				const forever = seconds > MUTE_MAX_SECONDS;
				const response = await chats.setDialogMute({ chatId: BigInt(chatId), forever, durationSeconds: forever ? 0 : seconds });
				return assertSafeId(response.muteUntil);
			}),
		setDialogPinned: (chatId, pinned) =>
			call(async () => (await chats.setDialogPinned({ chatId: BigInt(chatId), pinned })).pinnedChatIds.map(assertSafeId)),
		deleteChat: (chatId) =>
			call(async () => {
				await chats.deleteChat({ chatId: BigInt(chatId) });
			}),
		commonChats: (userId) =>
			call(async () => {
				const response = await chats.getCommonChats({ userId: BigInt(userId), limit: COMMON_PAGE });
				return { chats: response.chats.map(toChatBrief), count: response.count };
			}),
		reactions: (chatId, seq, emoji, cursor = "") =>
			call(async () => {
				const response = await messages.getMessageReactions({ chatId: BigInt(chatId), seq: BigInt(seq), emoji, cursor, limit: REACTIONS_PAGE });
				const people = peopleOf(response.users);
				const items = response.reactors.flatMap((reactor) => {
					const person = people.get(assertSafeId(reactor.userId));
					return person === undefined ? [] : [{ person, emoji: reactor.emoji, date: assertSafeId(reactor.date) }];
				});
				return { items, nextCursor: response.nextCursor };
			}),
		blockedUsers: (cursor = "") =>
			call(async () => {
				const response = await users.getBlockedUsers({ cursor, limit: BLOCKED_PAGE });
				const people = peopleOf(response.users);
				const items = response.blocked.flatMap((entry) => {
					const person = people.get(assertSafeId(entry.userId));
					return person === undefined ? [] : [{ person, blockedAt: assertSafeId(entry.blockedAt) }];
				});
				return { items, nextCursor: response.nextCursor };
			}),
		moderationGroups: (status, cursor = "") =>
			call(async () => {
				const response = await moderation.getReportGroups({ status: WIRE_STATUSES[status], cursor, limit: REPORTS_PAGE });
				return {
					groups: response.groups.flatMap((group) =>
						group.report === undefined
							? []
							: [{ report: toReport(group.report), count: group.reportCount, mainReason: WIRE_REASONS[group.mainReason] ?? "other" }],
					),
					people: peopleOf(response.users),
					chats: new Map(response.chats.map((chat) => [assertSafeId(chat.id), toChatBrief(chat)])),
					nextCursor: response.nextCursor,
				};
			}),
		moderationReport: (reportId) =>
			call(async () => {
				const response = await moderation.getReport({ reportId: BigInt(reportId) });
				if (response.report === undefined) throw new ConnectError("GetReport returned no report", Code.Internal);
				return {
					report: toReport(response.report),
					evidence: response.evidence.map((message) => ({
						seq: assertSafeId(message.seq),
						fromId: assertSafeId(message.fromId),
						date: assertSafeId(message.date),
						text: message.text,
						deleted: message.deleted,
					})),
					context: response.context.map((message) => ({
						seq: assertSafeId(message.seq),
						fromId: assertSafeId(message.fromId),
						date: assertSafeId(message.date),
						text: message.text,
					})),
					people: peopleOf(response.users),
					chat: response.chat === undefined ? null : toChatBrief(response.chat),
					history: knownEntries(response.history),
					restrictions: response.restrictions.map((restriction) => ({
						userId: assertSafeId(restriction.userId),
						until: assertSafeId(restriction.until),
						reason: restriction.reason,
						createdAt: assertSafeId(restriction.createdAt),
					})),
					group: {
						reportCount: response.group?.reportCount ?? 1,
						reporterCount: response.group?.reporterCount ?? 1,
						reasons: (response.group?.reasons ?? []).map((entry) => ({ reason: WIRE_REASONS[entry.reason] ?? "other", count: entry.count })),
						comments: response.group?.comments ?? [],
					},
					signals: response.signals.map((signal) => ({
						userId: assertSafeId(signal.userId),
						accountAgeSeconds: assertSafeId(signal.accountAgeSeconds),
						strangerChats24h: signal.strangerChats24h,
						blockedBy: signal.blockedBy,
						chatsJoined24h: signal.chatsJoined24h,
						otherOpenReports: signal.otherOpenReports,
					})),
					hooks: response.hooks.map((hook) => ({ id: hook.id, name: hook.name, disabled: hook.disabled })),
				};
			}),
		resolveReport: (reportId, actions, note, restrictSeconds, notify) =>
			call(async () => {
				const response = await moderation.resolveReport({
					reportId: BigInt(reportId),
					actions: actions.map((action) => WIRE_ACTIONS[action]),
					note,
					restrictSeconds,
					notify,
				});
				if (response.report === undefined) throw new ConnectError("ResolveReport returned no report", Code.Internal);
				return toReport(response.report);
			}),
		liftRestriction: (userId, note) =>
			call(async () => {
				await moderation.liftRestriction({ userId: BigInt(userId), note });
			}),
		moderationFeedback: (status, cursor = "") =>
			call(async () => {
				const response = await moderation.getFeedback({ status: WIRE_FEEDBACK_STATUSES[status], cursor, limit: FEEDBACK_PAGE });
				return { items: response.feedback.map(toFeedback), people: peopleOf(response.users), nextCursor: response.nextCursor };
			}),
		moderationLog: (filter: ModerationLogFilter, cursor = "", limit = LOG_PAGE) =>
			call(async () => {
				const response = await moderation.getModerationLog({
					operatorId: typeof filter.actor === "number" ? BigInt(filter.actor) : 0n,
					automaticOnly: filter.actor === "auto",
					action: filter.action === "all" ? WireAction.UNSPECIFIED : WIRE_ACTIONS[filter.action],
					since: BigInt(filter.since),
					cursor,
					limit,
				});
				return {
					entries: knownEntries(response.entries),
					people: peopleOf(response.users),
					chats: new Map(response.chats.map((chat) => [assertSafeId(chat.id), toChatBrief(chat)])),
					nextCursor: response.nextCursor,
				};
			}),
		botReview: (botId) =>
			call(async () => {
				const response = await moderation.getBotReview({ botId: BigInt(botId) });
				if (response.review === undefined) throw new ConnectError("GetBotReview returned no review", Code.Internal);
				return { reviews: [toBotReview(response.review)], people: peopleOf(response.users) };
			}),
		botReviews: () =>
			call(async () => {
				const response = await moderation.getBotReviews({});
				return { reviews: response.reviews.map(toBotReview), people: peopleOf(response.users) };
			}),
		setBotVerified: (botId, verified, note) =>
			call(async () => {
				const response = await moderation.setBotVerified({ botId: BigInt(botId), verified, note });
				if (response.review === undefined) throw new ConnectError("SetBotVerified returned no review", Code.Internal);
				return toBotReview(response.review);
			}),
		reviewBotRestriction: (botId, restore, note) =>
			call(async () => {
				const response = await moderation.reviewBotRestriction({ botId: BigInt(botId), restore, note });
				if (response.review === undefined) throw new ConnectError("ReviewBotRestriction returned no review", Code.Internal);
				return toBotReview(response.review);
			}),
		resolveFeedback: (feedbackId) =>
			call(async () => {
				const response = await moderation.resolveFeedback({ feedbackId: BigInt(feedbackId) });
				if (response.feedback === undefined) throw new ConnectError("ResolveFeedback returned no item", Code.Internal);
				return toFeedback(response.feedback);
			}),
		previewAnnouncement: (text) =>
			call(async () => {
				const response = await moderation.previewAnnouncement({ text });
				return { text: response.text, entities: response.entities.map(fromWireEntity), audience: response.audience };
			}),
		sendAnnouncement: (text) =>
			call(async () => toAnnouncement((await moderation.sendAnnouncement({ text })).announcement, "SendAnnouncement")),
		announcements: () =>
			call(async () => {
				const response = await moderation.getAnnouncements({});
				return {
					items: response.announcements.map((a) => toAnnouncement(a, "GetAnnouncements")),
					people: peopleOf(response.users),
					audience: response.audience,
				};
			}),
		cancelAnnouncement: (id) =>
			call(async () => toAnnouncement((await moderation.cancelAnnouncement({ announcementId: BigInt(id) })).announcement, "CancelAnnouncement")),
		replyFeedback: (feedbackId, text) =>
			call(async () => {
				const response = await moderation.replyFeedback({ feedbackId: BigInt(feedbackId), text });
				if (response.feedback === undefined) throw new ConnectError("ReplyFeedback returned no item", Code.Internal);
				return toFeedback(response.feedback);
			}),
		setPrivacy: (change) =>
			call(async () => {
				const request = {
					...(change.lastSeen === undefined ? {} : { lastSeen: WIRE_AUDIENCES[change.lastSeen] }),
					...(change.profilePhoto === undefined ? {} : { profilePhoto: WIRE_AUDIENCES[change.profilePhoto] }),
					...(change.findByEmail === undefined ? {} : { findByEmail: WIRE_AUDIENCES[change.findByEmail] }),
					...(change.findByUsername === undefined ? {} : { findByUsername: WIRE_AUDIENCES[change.findByUsername] }),
					...(change.addToGroups === undefined ? {} : { addToGroups: WIRE_AUDIENCES[change.addToGroups] }),
					...(change.sendMessages === undefined ? {} : { sendMessages: WIRE_AUDIENCES[change.sendMessages] }),
					...(change.notificationPreview === undefined ? {} : { notificationPreview: change.notificationPreview }),
				};
				return toPrivacy((await users.setPrivacy(request)).settings);
			}),
	};
}

