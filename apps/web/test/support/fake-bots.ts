// In-memory BotAdminService and BotsService for tests and the visual
// harness, with the server's rules the screens depend on: usernames ending
// in "bot" and unique, 20 bots per owner, a token shown once by
// ResetBotToken, a recent sign-in for ResetBotToken, DeleteBot and
// SetBotWebhook (reauth_required otherwise), and StartBot opening the
// private chat with "/start [param]". Callback presses answer what the test
// queued. Update delivery: a webhook (https, no internal address, a secret
// the first time and with every new URL), its status and counters as seeded,
// and dead letters to retry or drop.
// Never imported by production code.
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { BotAdminService, BotCommandScope, BotTier, type BotCommandSet } from "@app/proto-ts/bot_admin";
import { BotsService } from "@app/proto-ts/bots";
import type { Chat as WireChat } from "@app/proto-ts/chats";
import type { User as WireUser } from "@app/proto-ts/users";

/** What the fake needs from the chat fixture. */
export interface BotHost {
	readonly selfId: number;
	/** Adds a bot user (is_bot) and returns its id. */
	addBotUser(name: string, username: string): number;
	rename(userId: number, name: string): void;
	usernameTaken(username: string): boolean;
	wireUser(id: number): WireUser;
	/** The private chat of the signed-in user with `userId`, created when missing. */
	privateChat(userId: number): number;
	wireChat(chatId: number): WireChat;
	/** A text message from the signed-in user. */
	sendAsSelf(chatId: number, text: string): void;
}

interface FakeBot {
	id: number;
	username: string;
	name: string;
	description: string;
	about: string;
	privacy: boolean;
	commands: BotCommandSet[];
	tokenSecret: string;
	tokenIssuedAt: number;
	createdAt: number;
	deleted: boolean;
	/** Owned by the signed-in user (listed in the Developer Console). */
	owned: boolean;
	/** Unix seconds of the bot's last update fetch; 0 when it never asked. */
	lastUpdateAt: number;
	tier: BotTier;
	/** "" when the bot polls. */
	webhookUrl: string;
	/** The secret as set (the real server keeps it sealed and never returns it). */
	webhookSecret: string;
	allowedUpdates: string[];
	maxConnections: number;
	delivery: DeliverySeed;
	deadLetters: DeadLetterSeed[];
}

/** The delivery state GetBotDelivery reports. */
export interface DeliverySeed {
	pending: number;
	lastError: string;
	lastErrorAt: number;
	lastSuccessAt: number;
	lastSuccessMs: number;
	openConnections: number;
	received: number;
	delivered: number;
	failed: number;
	deadLettered: number;
}

export interface DeadLetterSeed {
	updateId: number;
	kind: string;
	chatId: number;
	chatTitle: string;
	lastError: string;
	lastErrorAt: number;
	attempts: number;
}

const NO_DELIVERY: DeliverySeed = {
	pending: 0,
	lastError: "",
	lastErrorAt: 0,
	lastSuccessAt: 0,
	lastSuccessMs: 0,
	openConnections: 0,
	received: 0,
	delivered: 0,
	failed: 0,
	deadLettered: 0,
};

export interface PressAnswerSeed {
	text?: string;
	showAlert?: boolean;
	url?: string;
	timedOut?: boolean;
}

const num = (value: bigint): number => Number(value);
const BOTS_MAX = 20;

export class FakeBots {
	readonly bots = new Map<number, FakeBot>();
	/** Requests in order ("CreateBot deploy_bot", "ResetBotToken 12", …). */
	readonly calls: string[] = [];
	/** CreateBot answers resource_exhausted (the server's creation rate limit). */
	createLimited = false;
	/** Whether the session signed in recently enough for ResetBotToken, DeleteBot and SetBotWebhook. */
	recentSignIn = true;
	readonly now = 1_760_500_000;
	/** PressInlineButton requests: chat, seq and the callback data as text. */
	readonly presses: { chatId: number; seq: number; data: string }[] = [];
	/** Answers for the next presses, in order; a press without one waits on `holdPress`, then answers "". */
	readonly answers: PressAnswerSeed[] = [];
	/** Set to hold presses until released (to see the waiting state). */
	holdPress: Promise<void> | null = null;
	/** StartBot random ids, in order. */
	readonly startRandomIds: bigint[] = [];
	/** The next StartBot does its work, then fails as if its answer was lost. */
	loseNextStartAnswer = false;
	/** GetBotInfo fails with unavailable this many more times. */
	failInfo = 0;
	private serial = 0;

	constructor(private readonly host: BotHost) {}

	/** A bot owned by the signed-in user, as if created earlier. */
	seed(name: string, username: string, extras: Partial<Omit<FakeBot, "id" | "username" | "name">> = {}): number {
		return this.adopt(this.host.addBotUser(name, username), name, username, extras);
	}

	/** Makes an existing bot user (seeded by the fixture) known to the bot services; not owned unless said. */
	adopt(id: number, name: string, username: string, extras: Partial<Omit<FakeBot, "id" | "username" | "name">> = {}): number {
		this.bots.set(id, {
			id,
			username,
			name,
			description: "",
			about: "",
			privacy: true,
			commands: [],
			tokenSecret: "",
			tokenIssuedAt: 0,
			createdAt: this.now - 86_400,
			deleted: false,
			owned: true,
			lastUpdateAt: 0,
			tier: BotTier.DEFAULT,
			webhookUrl: "",
			webhookSecret: "",
			allowedUpdates: [],
			maxConnections: 40,
			delivery: { ...NO_DELIVERY },
			deadLetters: [],
			...extras,
		});
		return id;
	}

	/** Sets a bot's command list for a scope (as the bot would through the Bot API). */
	setCommands(botId: number, scope: BotCommandScope, commands: { command: string; description: string }[]): void {
		const bot = this.bot(botId);
		bot.commands = [...bot.commands.filter((set) => set.scope !== scope), { scope, commands } as BotCommandSet];
	}

	private bot(botId: number): FakeBot {
		const bot = this.bots.get(botId);
		if (bot === undefined || bot.deleted) throw new ConnectError("bot not found", Code.NotFound);
		return bot;
	}

	/** A bot of the signed-in user (BotAdminService refuses anyone else's). */
	private own(botId: number): FakeBot {
		const bot = this.bot(botId);
		if (!bot.owned) throw new ConnectError("bot not found", Code.NotFound);
		return bot;
	}

	private wireBot(bot: FakeBot) {
		return {
			user: this.host.wireUser(bot.id),
			description: bot.description,
			about: bot.about,
			privacy: bot.privacy,
			commands: bot.commands,
			tier: bot.tier,
			hasToken: bot.tokenSecret !== "",
			createdAt: BigInt(bot.createdAt),
			tokenIssuedAt: BigInt(bot.tokenIssuedAt),
			lastUpdateAt: BigInt(bot.lastUpdateAt),
			webhook: bot.webhookUrl !== "",
		};
	}

	private wireWebhook(bot: FakeBot) {
		return { url: bot.webhookUrl, allowedUpdates: bot.allowedUpdates, maxConnections: bot.webhookUrl === "" ? 40 : bot.maxConnections };
	}

	/** The server's checks of SetBotWebhook that the Console shows. */
	private checkWebhook(bot: FakeBot, url: string, secret: string, maxConnections: number): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new ConnectError("url_invalid: not a URL", Code.InvalidArgument);
		}
		if (parsed.protocol !== "https:") throw new ConnectError("url_invalid: the scheme must be https", Code.InvalidArgument);
		if (/^(10\.|127\.|192\.168\.|169\.254\.)|^localhost$/.test(parsed.hostname)) {
			throw new ConnectError("url_blocked: the url points to a private, local or reserved address", Code.InvalidArgument);
		}
		if (parsed.hostname.endsWith(".invalid")) throw new ConnectError("url_unresolved: the url's host name does not resolve", Code.InvalidArgument);
		if (secret !== "" && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new ConnectError("secret_invalid: bad secret", Code.InvalidArgument);
		if (secret === "" && bot.webhookSecret === "") throw new ConnectError("secret_required: a secret is required", Code.InvalidArgument);
		if (secret === "" && url !== bot.webhookUrl) {
			throw new ConnectError("secret_required: a new secret is required when the url changes", Code.InvalidArgument);
		}
		if (maxConnections < 0 || maxConnections > 100) throw new ConnectError("max_connections_invalid: 1 to 100", Code.InvalidArgument);
	}

	private needRecentSignIn(): void {
		if (!this.recentSignIn) throw new ConnectError("reauth_required: sign in again within 10 minutes", Code.FailedPrecondition);
	}

	/** The menu GetBotInfo returns for the private chat: PRIVATE, else DEFAULT. */
	private menu(bot: FakeBot) {
		const of = (scope: BotCommandScope) => bot.commands.find((set) => set.scope === scope)?.commands;
		return of(BotCommandScope.PRIVATE) ?? of(BotCommandScope.DEFAULT) ?? [];
	}

	/** The answer of the next press. */
	async press(chatId: number, seq: number, data: string): Promise<PressAnswerSeed> {
		this.presses.push({ chatId, seq, data });
		if (this.holdPress !== null) await this.holdPress;
		return this.answers.shift() ?? {};
	}

	routes(router: ConnectRouter): void {
		router.service(BotAdminService, {
			listMyBots: () => {
				this.calls.push("ListMyBots");
				return { bots: [...this.bots.values()].filter((bot) => !bot.deleted && bot.owned).map((bot) => this.wireBot(bot)) };
			},
			createBot: (req) => {
				const username = req.username.toLowerCase();
				this.calls.push(`CreateBot ${username}`);
				if (!/^[a-z0-9_]{5,32}$/.test(username) || !username.endsWith("bot")) throw new ConnectError("bad username", Code.InvalidArgument);
				if (this.createLimited) throw new ConnectError("too many bots created, retry in 3 minutes", Code.ResourceExhausted);
				if (this.host.usernameTaken(username)) throw new ConnectError("username_taken: in use", Code.AlreadyExists);
				if ([...this.bots.values()].filter((bot) => !bot.deleted && bot.owned).length >= BOTS_MAX) {
					throw new ConnectError("bots_limit: 20 bots", Code.FailedPrecondition);
				}
				const id = this.seed(req.name, username, { createdAt: this.now });
				return { bot: this.wireBot(this.bot(id)) };
			},
			updateBot: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`UpdateBot ${bot.id}`);
				if (req.name !== undefined) {
					bot.name = req.name;
					this.host.rename(bot.id, req.name);
				}
				if (req.description !== undefined) bot.description = req.description;
				if (req.about !== undefined) bot.about = req.about;
				if (req.privacy !== undefined) bot.privacy = req.privacy;
				if (req.commands !== undefined) bot.commands = req.commands.sets;
				return { bot: this.wireBot(bot) };
			},
			resetBotToken: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`ResetBotToken ${bot.id}`);
				this.needRecentSignIn();
				bot.tokenSecret = `secret${++this.serial}${"x".repeat(30)}`;
				bot.tokenIssuedAt = this.now;
				return { bot: this.wireBot(bot), token: `${bot.id}:${bot.tokenSecret}` };
			},
			deleteBot: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`DeleteBot ${bot.id}`);
				this.needRecentSignIn();
				bot.deleted = true;
				return {};
			},
			getBotDelivery: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`GetBotDelivery ${bot.id}`);
				const d = bot.delivery;
				return {
					webhook: this.wireWebhook(bot),
					status: {
						pendingCount: BigInt(d.pending),
						deadLetterCount: BigInt(bot.deadLetters.length),
						lastError: d.lastError,
						lastErrorDate: BigInt(d.lastErrorAt),
						lastSuccessDate: BigInt(d.lastSuccessAt),
						lastSuccessMs: d.lastSuccessMs,
						openConnections: d.openConnections,
					},
					stats: {
						received: BigInt(d.received),
						delivered: BigInt(d.delivered),
						failed: BigInt(d.failed),
						deadLettered: BigInt(d.deadLettered),
					},
				};
			},
			setBotWebhook: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`SetBotWebhook ${bot.id} ${req.url}`);
				this.needRecentSignIn();
				this.checkWebhook(bot, req.url, req.secret, req.maxConnections);
				bot.webhookUrl = req.url;
				if (req.secret !== "") bot.webhookSecret = req.secret;
				bot.allowedUpdates = [...req.allowedUpdates];
				bot.maxConnections = req.maxConnections === 0 ? 40 : req.maxConnections;
				if (req.dropPending) bot.delivery.pending = 0;
				return { webhook: this.wireWebhook(bot) };
			},
			deleteBotWebhook: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`DeleteBotWebhook ${bot.id} ${req.dropPending}`);
				bot.webhookUrl = "";
				bot.webhookSecret = "";
				bot.allowedUpdates = [];
				bot.maxConnections = 40;
				if (req.dropPending) bot.delivery.pending = 0;
				return {};
			},
			listBotDeadLetters: (req) => {
				const bot = this.own(num(req.botId));
				this.calls.push(`ListBotDeadLetters ${bot.id}`);
				return {
					deadLetters: bot.deadLetters.map((d) => ({
						updateId: BigInt(d.updateId),
						kind: d.kind,
						chatId: BigInt(d.chatId),
						chatTitle: d.chatTitle,
						lastError: d.lastError,
						lastErrorDate: BigInt(d.lastErrorAt),
						attempts: d.attempts,
					})),
					total: BigInt(bot.deadLetters.length),
				};
			},
			retryBotDeadLetters: (req) => {
				const bot = this.own(num(req.botId));
				const ids = req.updateIds.map(num);
				this.calls.push(`RetryBotDeadLetters ${bot.id} ${ids.join(",")}`);
				const before = bot.deadLetters.length;
				bot.deadLetters = bot.deadLetters.filter((d) => !ids.includes(d.updateId));
				return { retried: before - bot.deadLetters.length };
			},
			discardBotDeadLetters: (req) => {
				const bot = this.own(num(req.botId));
				const ids = req.updateIds.map(num);
				this.calls.push(`DiscardBotDeadLetters ${bot.id} ${ids.join(",")}`);
				const before = bot.deadLetters.length;
				bot.deadLetters = bot.deadLetters.filter((d) => !ids.includes(d.updateId));
				return { discarded: before - bot.deadLetters.length };
			},
		});
		router.service(BotsService, {
			getBotInfo: (req) => {
				const bot = this.bot(num(req.botId));
				this.calls.push(`GetBotInfo ${bot.id}`);
				if (this.failInfo > 0) {
					this.failInfo--;
					throw new ConnectError("connection lost", Code.Unavailable);
				}
				return {
					user: this.host.wireUser(bot.id),
					description: bot.description,
					about: bot.about,
					commands: this.menu(bot),
					isOwner: bot.owned,
					lastUpdateAt: BigInt(bot.owned ? bot.lastUpdateAt : 0),
					// Judged by the server's clock, as the real server does.
					notRunning: bot.owned && Math.floor(Date.now() / 1000) - bot.lastUpdateAt > 120,
				};
			},
			startBot: (req) => {
				const bot = this.bot(num(req.botId));
				this.calls.push(`StartBot ${bot.id} ${req.startParam}`);
				this.startRandomIds.push(req.randomId);
				const chatId = this.host.privateChat(bot.id);
				// The server sends /start once per random id.
				if (this.startRandomIds.indexOf(req.randomId) === this.startRandomIds.length - 1) {
					this.host.sendAsSelf(chatId, req.startParam === "" ? "/start" : `/start ${req.startParam}`);
				}
				if (this.loseNextStartAnswer) {
					this.loseNextStartAnswer = false;
					throw new ConnectError("connection lost", Code.Unavailable);
				}
				return { chat: this.host.wireChat(chatId), users: [this.host.wireUser(bot.id)] };
			},
		});
	}
}
