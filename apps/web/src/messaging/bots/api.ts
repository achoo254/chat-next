// Bots on the client side (BotAdminService for the Developer Console,
// BotsService for starting a bot and its menu, MessagesService.PressInlineButton
// for callback buttons), mapped from the wire (ADR 0001: int64 arrive as
// bigint and leave as number). The Connect client and the generated schemas
// load on the first call (client.ts), so the first screen does not carry them.
// A token is only ever returned by resetToken, never kept here.
import type { Transport } from "@connectrpc/connect";

/** Where a command list applies (BotCommandScope); the Console edits private, group and group_admin. */
export type CommandScope = "default" | "private" | "group" | "group_admin";

export const EDITABLE_SCOPES: readonly CommandScope[] = ["private", "group", "group_admin"];

export interface BotCommand {
	/** 1 to 32 characters of a-z, 0-9 and _, without the slash. */
	readonly command: string;
	/** 1 to 256 characters. */
	readonly description: string;
}

export type CommandSets = Readonly<Partial<Record<CommandScope, readonly BotCommand[]>>>;

/** One of the caller's bots, as the Developer Console shows it. */
export interface OwnBot {
	readonly id: number;
	readonly name: string;
	readonly username: string;
	readonly description: string;
	readonly about: string;
	/** Privacy mode in groups (on by default). */
	readonly privacy: boolean;
	readonly commands: CommandSets;
	/** A valid token was issued. */
	readonly hasToken: boolean;
	/** Unix seconds. */
	readonly createdAt: number;
	/** Unix seconds; 0 without a token. */
	readonly tokenIssuedAt: number;
}

/** The fields UpdateBot changes; absent ones stay as they are. */
export interface BotChanges {
	readonly name?: string;
	readonly description?: string;
	readonly about?: string;
	readonly privacy?: boolean;
	/** Replaces every command list (scopes left out lose theirs). */
	readonly commands?: CommandSets;
}

/** A bot's public profile and its command menu for one chat (GetBotInfo). */
export interface BotInfo {
	readonly id: number;
	readonly name: string;
	readonly username: string;
	readonly description: string;
	readonly about: string;
	readonly commands: readonly BotCommand[];
}

/** The bot's answer to a callback button (PressInlineButton). */
export interface PressAnswer {
	readonly text: string;
	/** Show the text in a dialog instead of a toast. */
	readonly showAlert: boolean;
	/** A link the bot asks the client to open; "" for none. */
	readonly url: string;
	/** The bot did not answer within 10 seconds (the press still reached it). */
	readonly timedOut: boolean;
}

/** Name limits of the bot profile (bot_admin.proto). */
export const BOT_LIMITS = {
	name: 64,
	description: 512,
	about: 120,
	commandDescription: 256,
	commandsPerScope: 100,
	usernameMin: 5,
	usernameMax: 32,
} as const;

/** Why a bot call failed, as the screens tell it apart. */
export type BotErrorKind =
	/** ResetBotToken and DeleteBot need an IdP sign-in within the last 10 minutes. */
	| "reauth_required"
	/** The owner already has 20 bots. */
	| "bots_limit"
	/** Too many bots created lately (20, then one every 3 minutes). */
	| "rate_limited"
	/** The username belongs to a user or bot of the tenant. */
	| "username_taken"
	| "invalid"
	| "not_found"
	| "other";

/** A failed bot call; `kind` decides what the screen says. */
export class BotError extends Error {
	constructor(
		readonly kind: BotErrorKind,
		message: string,
	) {
		super(message);
		this.name = "BotError";
	}
}

export function botErrorKind(err: unknown): BotErrorKind {
	return err instanceof BotError ? err.kind : "other";
}

export interface Bots {
	/** The caller's bots, oldest first. */
	mine(): Promise<OwnBot[]>;
	/** BotError "username_taken", "bots_limit" or "rate_limited". The bot has no token yet. */
	create(username: string, name: string): Promise<OwnBot>;
	update(botId: number, changes: BotChanges): Promise<OwnBot>;
	/** A new token, shown once; BotError "reauth_required" without a recent sign-in. */
	resetToken(botId: number): Promise<{ bot: OwnBot; token: string }>;
	/** BotError "reauth_required" without a recent sign-in. */
	remove(botId: number): Promise<void>;
	/** null when no bot has this username (or it is a person). */
	resolve(username: string): Promise<BotInfo | null>;
	/** Whether a user or bot of the tenant has this username already (best effort; the server decides). */
	usernameTaken(username: string): Promise<boolean>;
	/** Profile and command menu for `chatId` (0: the private chat with the bot). */
	info(botId: number, chatId: number): Promise<BotInfo>;
	/** Records consent, opens the private chat and sends "/start [param]"; returns the chat id. */
	start(botId: number, startParam: string): Promise<number>;
	/** `callbackData`: the button's data as standard base64. */
	press(chatId: number, seq: number, callbackData: string): Promise<PressAnswer>;
}

/**
 * The bot calls on `transport`, loading the Connect client on the first call
 * (a failed load is tried again on the next call). `onUnauthenticated` runs
 * when the session is gone; the error is rethrown.
 */
export function createBots(transport: Transport, onUnauthenticated: () => void): Bots {
	let client: Promise<Bots> | null = null;
	const load = (): Promise<Bots> => {
		client ??= import("./client.ts")
			.then((module) => module.createBotsClient(transport, onUnauthenticated))
			.catch((err: unknown) => {
				client = null;
				throw err;
			});
		return client;
	};
	return {
		mine: () => load().then((api) => api.mine()),
		create: (username, name) => load().then((api) => api.create(username, name)),
		update: (botId, changes) => load().then((api) => api.update(botId, changes)),
		resetToken: (botId) => load().then((api) => api.resetToken(botId)),
		remove: (botId) => load().then((api) => api.remove(botId)),
		resolve: (username) => load().then((api) => api.resolve(username)),
		usernameTaken: (username) => load().then((api) => api.usernameTaken(username)),
		info: (botId, chatId) => load().then((api) => api.info(botId, chatId)),
		start: (botId, startParam) => load().then((api) => api.start(botId, startParam)),
		press: (chatId, seq, callbackData) => load().then((api) => api.press(chatId, seq, callbackData)),
	};
}

/** Bot usernames: 5 to 32 of a-z, 0-9 and _ ending in "bot" (any case on the wire, lowercase here). */
export function usernameProblem(username: string): "chars" | "suffix" | "length" | null {
	if (!/^[a-z0-9_]*$/.test(username)) return "chars";
	if (username.length < BOT_LIMITS.usernameMin || username.length > BOT_LIMITS.usernameMax) return "length";
	if (!username.endsWith("bot")) return "suffix";
	return null;
}

/** A command name: 1 to 32 of a-z, 0-9 and _. */
export function validCommand(command: string): boolean {
	return /^[a-z0-9_]{1,32}$/.test(command);
}

/** Deep-link start parameters: up to 64 of A-Z, a-z, 0-9, _ and -. */
export function validStartParam(param: string): boolean {
	return /^[A-Za-z0-9_-]{0,64}$/.test(param);
}
