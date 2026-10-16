// Connect implementation of Bots (see api.ts), loaded on first use.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId, fromBase64, toMediaRef } from "@app/core";
import {
	BotAdminService,
	BotCommandScope as WireScope,
	BotTier,
	type Bot as WireBot,
	type BotCommand as WireCommand,
	type BotCommandSet as WireCommandSet,
	type BotDeadLetter as WireDeadLetter,
	type BotWebhook as WireWebhook,
	type GetBotDeliveryResponse,
} from "@app/proto-ts/bot_admin";
import {
	BotsService,
	InlineResultKind,
	type GetBotInfoResponse,
	type GetChatBotCommandsResponse,
	type InlineResult as WireInlineResult,
} from "@app/proto-ts/bots";
import { MessagesService } from "@app/proto-ts/messages";
import { UsersService } from "@app/proto-ts/users";
import {
	BotError,
	type InlineItem,
	type InlineKind,
	type BotChanges,
	type BotCommand,
	type BotDelivery,
	type BotErrorKind,
	type BotInfo,
	type BotTierName,
	type Bots,
	type BotWebhook,
	type ChatMenus,
	type CommandScope,
	type CommandSets,
	type DeadLetter,
	type OwnBot,
} from "./api.ts";

const SCOPES: Partial<Record<WireScope, CommandScope>> = {
	[WireScope.DEFAULT]: "default",
	[WireScope.PRIVATE]: "private",
	[WireScope.GROUP]: "group",
	[WireScope.GROUP_ADMIN]: "group_admin",
};

const WIRE_SCOPES: Record<CommandScope, WireScope> = {
	default: WireScope.DEFAULT,
	private: WireScope.PRIVATE,
	group: WireScope.GROUP,
	group_admin: WireScope.GROUP_ADMIN,
};

const TIERS: Partial<Record<BotTier, BotTierName>> = {
	[BotTier.NEW]: "new",
	[BotTier.DEFAULT]: "default",
	[BotTier.VERIFIED]: "verified",
	[BotTier.INTERNAL]: "internal",
	[BotTier.RESTRICTED]: "restricted",
};

function toCommand(command: WireCommand): BotCommand {
	return { command: command.command, description: command.description };
}

/** Command lists by scope; a scope this client does not know is left out. */
export function toCommandSets(sets: readonly WireCommandSet[]): CommandSets {
	const result: Partial<Record<CommandScope, readonly BotCommand[]>> = {};
	for (const set of sets) {
		const scope = SCOPES[set.scope];
		if (scope !== undefined) result[scope] = set.commands.map(toCommand);
	}
	return result;
}

export function toOwnBot(bot: WireBot | undefined, method: string): OwnBot {
	const user = bot?.user;
	if (bot === undefined || user === undefined) throw new BotError("other", `${method} returned no bot`);
	return {
		id: assertSafeId(user.id),
		name: user.name,
		username: user.username,
		description: bot.description,
		about: bot.about,
		privacy: bot.privacy,
		commands: toCommandSets(bot.commands),
		hasToken: bot.hasToken,
		createdAt: assertSafeId(bot.createdAt),
		tokenIssuedAt: assertSafeId(bot.tokenIssuedAt),
		lastUpdateAt: assertSafeId(bot.lastUpdateAt),
		webhook: bot.webhook,
		tier: TIERS[bot.tier] ?? "default",
		inlinePlaceholder: bot.inlinePlaceholder,
	};
}

const INLINE_KINDS: Partial<Record<InlineResultKind, InlineKind>> = {
	[InlineResultKind.ARTICLE]: "article",
	[InlineResultKind.PHOTO]: "photo",
	[InlineResultKind.VIDEO]: "video",
	[InlineResultKind.DOCUMENT]: "document",
};

/** A result the client knows how to show; null for a newer kind. */
function toInlineItem(r: WireInlineResult): InlineItem | null {
	const kind = INLINE_KINDS[r.kind];
	if (kind === undefined) return null;
	return {
		id: r.id,
		kind,
		title: r.title,
		description: r.description,
		...(r.media === undefined ? {} : { media: toMediaRef(r.media) }),
		...(r.thumbnail === undefined ? {} : { thumbnail: toMediaRef(r.thumbnail) }),
	};
}

function toWebhook(webhook: WireWebhook | undefined): BotWebhook {
	return { url: webhook?.url ?? "", allowedUpdates: webhook?.allowedUpdates ?? [], maxConnections: webhook?.maxConnections ?? 0 };
}

function toDelivery(response: GetBotDeliveryResponse): BotDelivery {
	const status = response.status;
	const stats = response.stats;
	return {
		webhook: toWebhook(response.webhook),
		status: {
			pending: assertSafeId(status?.pendingCount ?? 0n),
			deadLetters: assertSafeId(status?.deadLetterCount ?? 0n),
			lastError: status?.lastError ?? "",
			lastErrorAt: assertSafeId(status?.lastErrorDate ?? 0n),
			lastSuccessAt: assertSafeId(status?.lastSuccessDate ?? 0n),
			lastSuccessMs: status?.lastSuccessMs ?? 0,
			openConnections: status?.openConnections ?? 0,
		},
		stats: {
			received: assertSafeId(stats?.received ?? 0n),
			delivered: assertSafeId(stats?.delivered ?? 0n),
			failed: assertSafeId(stats?.failed ?? 0n),
			deadLettered: assertSafeId(stats?.deadLettered ?? 0n),
		},
	};
}

function toDeadLetter(d: WireDeadLetter): DeadLetter {
	return {
		updateId: assertSafeId(d.updateId),
		kind: d.kind,
		chatId: assertSafeId(d.chatId),
		chatTitle: d.chatTitle,
		lastError: d.lastError,
		lastErrorAt: assertSafeId(d.lastErrorDate),
		attempts: d.attempts,
	};
}

function toInfo(response: GetBotInfoResponse): BotInfo {
	const user = response.user;
	if (user === undefined) throw new BotError("other", "GetBotInfo returned no user");
	return {
		id: assertSafeId(user.id),
		name: user.name,
		username: user.username,
		description: response.description,
		about: response.about,
		commands: response.commands.map(toCommand),
		isOwner: response.isOwner,
		notRunning: response.isOwner && response.notRunning,
		inlinePlaceholder: user.botInlinePlaceholder,
	};
}

function toMenus(response: GetChatBotCommandsResponse): ChatMenus {
	const bots = [];
	for (const entry of response.bots) {
		const bot = entry.bot;
		if (bot === undefined || bot.username === "") continue;
		bots.push({ botId: assertSafeId(bot.id), name: bot.name, username: bot.username, commands: entry.commands.map(toCommand) });
	}
	return { bots, botCount: response.botCount };
}

/** The server's error codes ("reauth_required: …") ride at the start of the message. */
export function errorKindOf(err: ConnectError): BotErrorKind {
	const message = err.rawMessage;
	switch (err.code) {
		case Code.FailedPrecondition:
			if (message.startsWith("reauth_required")) return "reauth_required";
			if (message.startsWith("bots_limit")) return "bots_limit";
			if (message.startsWith("bot_timeout")) return "bot_timeout";
			if (message.startsWith("inline_off")) return "inline_off";
			return "other";
		case Code.AlreadyExists:
			return message.startsWith("username_taken") || message === "" ? "username_taken" : "other";
		case Code.ResourceExhausted:
			return "rate_limited";
		case Code.InvalidArgument:
			return "invalid";
		case Code.NotFound:
			return "not_found";
		default:
			return "other";
	}
}

function wireSets(sets: CommandSets): { sets: { scope: WireScope; commands: BotCommand[] }[] } {
	const list: { scope: WireScope; commands: BotCommand[] }[] = [];
	for (const scope of Object.keys(WIRE_SCOPES) as CommandScope[]) {
		const commands = sets[scope];
		if (commands !== undefined && commands.length > 0) list.push({ scope: WIRE_SCOPES[scope], commands: commands.map((c) => ({ ...c })) });
	}
	return { sets: list };
}

/** A callback press with no answer by then reads "Bot không phản hồi". */
export const PRESS_TIMEOUT_MS = 15_000;

export function createBotsClient(transport: Transport, onUnauthenticated: () => void): Bots {
	const admin = createClient(BotAdminService, transport);
	const bots = createClient(BotsService, transport);
	const messages = createClient(MessagesService, transport);
	const users = createClient(UsersService, transport);

	async function call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			if (err instanceof BotError) throw err;
			const connect = ConnectError.from(err);
			if (connect.code === Code.Unauthenticated) onUnauthenticated();
			throw new BotError(errorKindOf(connect), connect.rawMessage);
		}
	}

	/** The user with this username, or null when the server knows none. */
	async function lookup(username: string) {
		try {
			return (await users.resolveUsername({ username })).user ?? null;
		} catch (err) {
			if (ConnectError.from(err).code === Code.NotFound) return null;
			throw err;
		}
	}

	const info = (botId: number, chatId: number) =>
		call(async () => toInfo(await bots.getBotInfo({ botId: BigInt(botId), chatId: BigInt(chatId) })));

	return {
		mine: () => call(async () => (await admin.listMyBots({})).bots.map((bot) => toOwnBot(bot, "ListMyBots"))),
		create: (username, name) => call(async () => toOwnBot((await admin.createBot({ username, name })).bot, "CreateBot")),
		update: (botId, changes: BotChanges) =>
			call(async () => {
				const response = await admin.updateBot({
					botId: BigInt(botId),
					...(changes.name === undefined ? {} : { name: changes.name }),
					...(changes.description === undefined ? {} : { description: changes.description }),
					...(changes.about === undefined ? {} : { about: changes.about }),
					...(changes.privacy === undefined ? {} : { privacy: changes.privacy }),
					...(changes.commands === undefined ? {} : { commands: wireSets(changes.commands) }),
					...(changes.inlinePlaceholder === undefined ? {} : { inlinePlaceholder: changes.inlinePlaceholder }),
				});
				return toOwnBot(response.bot, "UpdateBot");
			}),
		resetToken: (botId) =>
			call(async () => {
				const response = await admin.resetBotToken({ botId: BigInt(botId) });
				if (response.token === "") throw new BotError("other", "ResetBotToken returned no token");
				return { bot: toOwnBot(response.bot, "ResetBotToken"), token: response.token };
			}),
		remove: (botId) =>
			call(async () => {
				await admin.deleteBot({ botId: BigInt(botId) });
			}),
		resolve: (username) =>
			call(async () => {
				const user = await lookup(username);
				if (user === null || !user.isBot) return null;
				return toInfo(await bots.getBotInfo({ botId: user.id, chatId: 0n }));
			}),
		usernameTaken: (username) => call(async () => (await lookup(username)) !== null),
		info,
		chatMenus: (chatId) => call(async () => toMenus(await bots.getChatBotCommands({ chatId: BigInt(chatId) }))),
		start: (botId, startParam, randomId) =>
			call(async () => {
				const response = await bots.startBot({ botId: BigInt(botId), startParam, randomId: BigInt(randomId) });
				const chat = response.chat;
				if (chat === undefined) throw new BotError("other", "StartBot returned no chat");
				return assertSafeId(chat.id);
			}),
		inlineQuery: (botId, chatId, query) =>
			call(async () => {
				const response = await bots.inlineQuery({ botId: BigInt(botId), chatId: BigInt(chatId), query, offset: "" });
				return {
					queryId: response.queryId,
					items: response.results.flatMap((r) => toInlineItem(r) ?? []),
					gallery: response.gallery,
				};
			}),
		sendInlineResult: (chatId, topicId, queryId, resultId, randomId) =>
			call(async () => {
				await messages.sendInlineResult({
					chatId: BigInt(chatId),
					topicId: BigInt(topicId),
					queryId,
					resultId,
					randomId: BigInt(randomId),
				});
			}),
		press: (chatId, seq, callbackData) =>
			call(async () => {
				const data = fromBase64(callbackData);
				if (data === null || data.length === 0) throw new BotError("invalid", "button without callback data");
				// The server gives up on a slow bot after 10 seconds; this covers a
				// connection that stalls (proxy, network lost, a laptop waking up).
				const controller = new AbortController();
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stalled = new Promise<null>((resolve) => {
					timer = setTimeout(() => {
						resolve(null);
						controller.abort();
					}, PRESS_TIMEOUT_MS);
				});
				try {
					const answer = await Promise.race([
						messages.pressInlineButton({ chatId: BigInt(chatId), seq: BigInt(seq), callbackData: data }, { signal: controller.signal }),
						stalled,
					]);
					if (answer === null) return { text: "", showAlert: false, url: "", timedOut: true };
					return { text: answer.text, showAlert: answer.showAlert, url: answer.url, timedOut: answer.timedOut };
				} finally {
					clearTimeout(timer);
				}
			}),
		delivery: (botId) => call(async () => toDelivery(await admin.getBotDelivery({ botId: BigInt(botId) }))),
		setWebhook: (botId, changes) =>
			call(async () => {
				const response = await admin.setBotWebhook({
					botId: BigInt(botId),
					url: changes.url.trim(),
					secret: changes.secret,
					allowedUpdates: [...changes.allowedUpdates],
					maxConnections: changes.maxConnections,
					dropPending: changes.dropPending,
				});
				return toWebhook(response.webhook);
			}),
		deleteWebhook: (botId, dropPending) =>
			call(async () => {
				await admin.deleteBotWebhook({ botId: BigInt(botId), dropPending });
			}),
		deadLetters: (botId) =>
			call(async () => {
				const response = await admin.listBotDeadLetters({ botId: BigInt(botId) });
				return { list: response.deadLetters.map(toDeadLetter), total: assertSafeId(response.total) };
			}),
		retryDeadLetters: (botId, ids) =>
			call(async () => (await admin.retryBotDeadLetters({ botId: BigInt(botId), updateIds: ids.map((id) => BigInt(id)) })).retried),
		discardDeadLetters: (botId, ids) =>
			call(async () => (await admin.discardBotDeadLetters({ botId: BigInt(botId), updateIds: ids.map((id) => BigInt(id)) })).discarded),
	};
}
