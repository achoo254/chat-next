import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "./client.ts";
import type {
	AnswerInlineQueryRequest,
	Callback,
	InlineQuery,
	InlineQueryResult,
	Me,
	Message,
	SendMessageRequest,
	Update,
	WebhookAnswer,
} from "./generated.ts";
import { poll } from "./polling.ts";
import type { PollOptions } from "./polling.ts";
import { webhookHandler } from "./webhook.ts";

/**
 * Handles one routed update. It may return a `WebhookAnswer`: at a webhook
 * it becomes the answer's body, in a long poll the bot calls that method.
 * Any other return value is ignored.
 */
export type Handler = (ctx: Context) => unknown;

/** Update kinds routed with `Bot.on`; the others have their own methods. */
export type OtherUpdateKind = "message_edited" | "channel_post" | "member_changed" | "reaction";

const OTHER_KINDS: readonly OtherUpdateKind[] = ["message_edited", "channel_post", "member_changed", "reaction"];

/** Options of `Context.reply`; `chat_id` and `text` come from the context. */
export type ReplyOptions = Omit<SendMessageRequest, "chat_id" | "text">;

/** Options of `Context.answerInline`; `results` is the first argument. */
export type AnswerInlineOptions = Omit<AnswerInlineQueryRequest, "results">;

/** What a handler gets: the update, the client and shortcuts for answering. */
export class Context {
	/** The update being handled. */
	readonly update: Update;
	/** The bot's client, for any API method. */
	readonly client: Client;
	/** The command name (lowercase, without `/` and `@username`) when the message is a command for this bot. */
	readonly command: string | undefined;
	/** Text after the command, trimmed; empty when there is none. */
	readonly args: string;

	constructor(update: Update, client: Client, command?: string, args = "") {
		this.update = update;
		this.client = client;
		this.command = command;
		this.args = args;
	}

	/** The message of the update, or the bot's message whose button was pressed. */
	get message(): Message | undefined {
		const u = this.update;
		return u.message ?? u.channel_post ?? u.message_edited ?? u.callback?.message;
	}

	/** The button press, for `callback` updates. */
	get callback(): Callback | undefined {
		return this.update.callback;
	}

	/** The inline query, for `inline_query` updates. */
	get inlineQuery(): InlineQuery | undefined {
		return this.update.inline_query;
	}

	/**
	 * Sends a text message into the chat of the update's message (or of the
	 * message whose button was pressed), in the same topic.
	 */
	reply(text: string, options: ReplyOptions = {}): Promise<Message> {
		const message = this.message;
		if (message === undefined) {
			return Promise.reject(new Error("reply needs an update with a message"));
		}
		const topic = message.topic_id === undefined ? {} : { topic_id: message.topic_id };
		return this.client.sendMessage({ ...topic, ...options, chat_id: message.chat.id, text });
	}

	/** Answers the button press (`answerCallback`), optionally with a toast or an alert. */
	answer(text?: string, showAlert?: boolean): Promise<void> {
		const callback = this.update.callback;
		if (callback === undefined) {
			return Promise.reject(new Error("answer needs a callback update"));
		}
		return this.client.answerCallback(callback.id, {
			...(text === undefined ? {} : { text }),
			...(showAlert === undefined ? {} : { show_alert: showAlert }),
		});
	}

	/** Answers the inline query (`answerInlineQuery`). */
	answerInline(results: InlineQueryResult[], options: AnswerInlineOptions = {}): Promise<void> {
		const query = this.update.inline_query;
		if (query === undefined) {
			return Promise.reject(new Error("answerInline needs an inline_query update"));
		}
		return this.client.answerInlineQuery(query.id, { ...options, results });
	}
}

/** Options of a `Bot`. */
export interface BotOptions {
	/** Receives handler errors in a long poll or at a webhook (default: `console.error`). */
	readonly onError?: (error: unknown, update: Update) => void;
}

/**
 * Routes updates to handlers. The same bot serves a long poll (`poll`) or a
 * webhook (`webhookHandler`); unknown update kinds are ignored.
 */
export class Bot {
	/** The client the bot calls the API with. */
	readonly client: Client;
	readonly #onError: ((error: unknown, update: Update) => void) | undefined;
	readonly #commands = new Map<string, Handler>();
	readonly #callbacks: { prefix: string; handler: Handler }[] = [];
	readonly #kinds = new Map<OtherUpdateKind, Handler>();
	#inlineQuery: Handler | undefined;
	#message: Handler | undefined;
	#me: Promise<Me> | undefined;
	#username: string | undefined;

	constructor(client: Client, options: BotOptions = {}) {
		this.client = client;
		this.#onError = options.onError;
	}

	/** The bot's username once `init` ran (undefined before, or when it has none). */
	get username(): string | undefined {
		return this.#username;
	}

	/** Fetches the bot's profile with `getMe` once; later calls reuse it. */
	init(): Promise<Me> {
		if (this.#me === undefined) {
			const me = this.client.getMe().then((profile) => {
				this.#username = profile.username;
				return profile;
			});
			// A failed attempt is not cached: the next call asks again.
			me.catch(() => {
				if (this.#me === me) {
					this.#me = undefined;
				}
			});
			this.#me = me;
		}
		return this.#me;
	}

	/**
	 * Handles `/name` commands: a message whose first entity at offset 0 is a
	 * `bot_command`. `/name@username` matches only this bot's username.
	 */
	command(name: string, handler: Handler): this {
		const key = name.replace(/^\//, "").toLowerCase();
		if (!/^[a-z0-9_]+$/.test(key)) {
			throw new TypeError(`invalid command name "${name}"`);
		}
		this.#commands.set(key, handler);
		return this;
	}

	/** Handles button presses whose `callback_data` starts with `prefix`; the longest prefix wins. */
	callback(prefix: string, handler: Handler): this {
		const existing = this.#callbacks.findIndex((route) => route.prefix === prefix);
		if (existing >= 0) {
			this.#callbacks.splice(existing, 1);
		}
		this.#callbacks.push({ prefix, handler });
		this.#callbacks.sort((a, b) => b.prefix.length - a.prefix.length);
		return this;
	}

	/** Handles `inline_query` updates. */
	inlineQuery(handler: Handler): this {
		this.#inlineQuery = handler;
		return this;
	}

	/** Handles every `message` update that no command handler took. */
	message(handler: Handler): this {
		this.#message = handler;
		return this;
	}

	/** Handles one of the other update kinds. */
	on(kind: OtherUpdateKind, handler: Handler): this {
		this.#kinds.set(kind, handler);
		return this;
	}

	/**
	 * Routes one update. Returns the handler's `WebhookAnswer`, if any.
	 * Handler errors propagate.
	 */
	async handleUpdate(update: Update): Promise<WebhookAnswer | undefined> {
		const result = await this.#dispatch(update);
		return isWebhookAnswer(result) ? result : undefined;
	}

	/** Long polls and routes every update (see `poll`); fetches the username first. */
	async poll(options: PollOptions = {}): Promise<void> {
		await this.init();
		await poll(
			this.client,
			async (update) => {
				const answer = await this.handleUpdate(update);
				if (answer !== undefined) {
					await this.#runAnswer(answer);
				}
			},
			{ ...this.#errorOption(), ...options },
		);
	}

	/** A `node:http` listener serving the bot's webhook (see `webhookHandler`). */
	webhookHandler(secret: string): (req: IncomingMessage, res: ServerResponse) => void {
		return webhookHandler({ secret, onUpdate: (update) => this.handleUpdate(update), ...this.#errorOption() });
	}

	#errorOption(): { onError?: (error: unknown, update: Update) => void } {
		return this.#onError === undefined ? {} : { onError: this.#onError };
	}

	async #dispatch(update: Update): Promise<unknown> {
		if (update.message !== undefined) {
			return this.#dispatchMessage(update, update.message);
		}
		if (update.callback !== undefined) {
			const data = update.callback.data;
			const route = this.#callbacks.find((r) => data.startsWith(r.prefix));
			return route?.handler(new Context(update, this.client));
		}
		if (update.inline_query !== undefined) {
			return this.#inlineQuery?.(new Context(update, this.client));
		}
		for (const kind of OTHER_KINDS) {
			if (update[kind] !== undefined) {
				return this.#kinds.get(kind)?.(new Context(update, this.client));
			}
		}
		return undefined;
	}

	async #dispatchMessage(update: Update, message: Message): Promise<unknown> {
		const parsed = await this.#parseCommand(message);
		if (parsed !== undefined) {
			const ctx = new Context(update, this.client, parsed.name, parsed.args);
			const handler = this.#commands.get(parsed.name) ?? this.#message;
			return handler?.(ctx);
		}
		return this.#message?.(new Context(update, this.client));
	}

	/** The command of a message when it is addressed to this bot. */
	async #parseCommand(message: Message): Promise<{ name: string; args: string } | undefined> {
		const text = message.text;
		const entity = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
		if (text === undefined || entity === undefined || !text.startsWith("/")) {
			return undefined;
		}
		const [name = "", target] = text.slice(1, entity.length).split("@", 2);
		if (name === "") {
			return undefined;
		}
		if (target !== undefined) {
			const me = await this.init();
			if (me.username === undefined || me.username.toLowerCase() !== target.toLowerCase()) {
				return undefined;
			}
		}
		return { name: name.toLowerCase(), args: text.slice(entity.length).trim() };
	}

	async #runAnswer(answer: WebhookAnswer): Promise<void> {
		if (answer.method === "sendMessage") {
			const { method: _method, ...request } = answer;
			await this.client.sendMessage(request);
			return;
		}
		const { method: _method, callback_id, ...request } = answer;
		await this.client.answerCallback(callback_id, request);
	}
}

function isWebhookAnswer(value: unknown): value is WebhookAnswer {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		(v["method"] === "sendMessage" && typeof v["chat_id"] === "number" && typeof v["text"] === "string") ||
		(v["method"] === "answerCallback" && typeof v["callback_id"] === "string")
	);
}
