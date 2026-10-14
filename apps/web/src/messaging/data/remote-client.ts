// Connect implementation of Remote (see remote.ts), with the protocol
// mapping (ADR 0001: every int64 arrives as a bigint and leaves as a number).
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@app/core";
import { cryptoRandomId } from "@app/platform";
import {
	ChatsService,
	ChatType,
	HistoryVisibility,
	MemberRole as WireRole,
	type ChatMember,
	type ForumTopic,
	type InviteLink,
} from "@app/proto-ts/chats";
import { ConfigService } from "@app/proto-ts/config";
import { MessagesService } from "@app/proto-ts/messages";
import {
	PrivacyAudience,
	ReportReason as WireReason,
	UsersService,
	UserStatusKind,
	type PrivacySettings,
	type User as WireUser,
} from "@app/proto-ts/users";
import type { ReportReason } from "./pending-backend.ts";
import type { Audience, Invite, Limits, Member, Person, Presence, Privacy, Remote, Role, ServerTopic } from "./remote.ts";

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

/**
 * The report reasons of the mock (spam, scam, violence, sexual, other) map
 * onto ReportReason; scam and sexual content have no value of their own yet,
 * so they go as OTHER with a tag at the start of the comment.
 */
const REPORT_REASONS: Record<ReportReason, { reason: WireReason; tag: string }> = {
	spam: { reason: WireReason.SPAM, tag: "" },
	scam: { reason: WireReason.OTHER, tag: "[scam]" },
	violence: { reason: WireReason.VIOLENCE, tag: "" },
	sexual: { reason: WireReason.OTHER, tag: "[sexual]" },
	other: { reason: WireReason.OTHER, tag: "" },
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
		pin: (chatId, seq) =>
			call(async () => {
				await messages.pinMessage({ chatId: BigInt(chatId), seq: BigInt(seq) });
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
		createGroup: (title, userIds) =>
			call(async () => {
				const response = await chats.createGroup({ title, userIds: userIds.map(BigInt) });
				return {
					chatId: requireChatId(response.chat, "CreateGroup"),
					failedUserIds: response.failedUserIds.map(assertSafeId),
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
				return response.failedUserIds.map(assertSafeId);
			}),
		leaveChat: (chatId) =>
			call(async () => {
				await chats.leaveChat({ chatId: BigInt(chatId) });
			}),
		setAdmin: (chatId, userId, admin) =>
			call(async () => {
				await chats.setAdmin({ chatId: BigInt(chatId), userId: BigInt(userId), admin });
			}),
		setDefaultPermissions: (chatId, permissions) =>
			call(async () => {
				await chats.updateChatInfo({ chatId: BigInt(chatId), defaultPermissions: permissions });
			}),
		setHistoryShared: (chatId, shared) =>
			call(async () => {
				await chats.setHistoryVisibility({
					chatId: BigInt(chatId),
					historyVisibility: shared ? HistoryVisibility.SHARED : HistoryVisibility.SINCE_JOIN,
				});
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
		forumTopics: (chatId) =>
			call(async () => {
				const response = await chats.getForumTopics({ chatId: BigInt(chatId) });
				return {
					topics: response.topics.map(toTopic),
					tops: response.messages.map((m) => ({
						seq: assertSafeId(m.seq),
						fromId: assertSafeId(m.fromId),
						text: m.text,
						date: assertSafeId(m.date),
					})),
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
		sendToTopic: (chatId, topicId, text, replyToSeq) =>
			call(async () => {
				await messages.sendMessage({
					chatId: BigInt(chatId),
					text,
					replyToSeq: BigInt(replyToSeq),
					topicId: BigInt(topicId),
					randomId: BigInt(cryptoRandomId()),
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
				const mapped = REPORT_REASONS[reason];
				const text = [mapped.tag, comment].filter((part) => part !== "").join(" ");
				const wireTarget =
					target.kind === "user"
						? { case: "userId" as const, value: BigInt(target.userId) }
						: target.kind === "chat"
							? { case: "chatId" as const, value: BigInt(target.chatId) }
							: { case: "messages" as const, value: { chatId: BigInt(target.chatId), seqs: [BigInt(target.seq)] } };
				await users.report({ target: wireTarget, reason: mapped.reason, comment: text });
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
			call(async () => (await messages.getMessageReaders({ chatId: BigInt(chatId), seq: BigInt(seq) })).users.map(toPerson)),
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

