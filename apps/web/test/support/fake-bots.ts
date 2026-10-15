// In-memory BotAdminService and BotsService for tests and the visual
// harness, with the server's rules the screens depend on: usernames ending
// in "bot" and unique, 20 bots per owner, a token shown once by
// ResetBotToken, a recent sign-in for ResetBotToken and DeleteBot
// (reauth_required otherwise), and StartBot opening the private chat with
// "/start [param]". Callback presses answer what the test queued. Never
// imported by production code.
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
}

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
	/** Whether the session signed in recently enough for ResetBotToken and DeleteBot. */
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
			tier: BotTier.DEFAULT,
			hasToken: bot.tokenSecret !== "",
			createdAt: BigInt(bot.createdAt),
			tokenIssuedAt: BigInt(bot.tokenIssuedAt),
			lastUpdateAt: BigInt(bot.lastUpdateAt),
		};
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
