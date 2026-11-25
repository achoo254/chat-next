/**
 * The chats whose new messages go into their AI session (chat-inbox.ts),
 * kept on the machine only: `chat-inbox.json` in tunelo's data folder,
 * owner-only. Counters (turns this hour, missed messages) are not kept: a
 * restart starts them again.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFile } from "@tunelo/client";

export const CHAT_INBOX_FILE = "chat-inbox.json";

/** Turns an hour a new subscription may push. */
export const DEFAULT_PER_HOUR_LIMIT = 20;
export const MAX_PER_HOUR_LIMIT = 120;

export interface InboxSubscription {
	/** The chat, as a decimal string (Chat's ids fit in 53 bits, kept exact all the same). */
	chatId: string;
	title: string;
	/** "telegram", "zalo", or "" for Chat itself. */
	app: string;
	enabled: boolean;
	perHourLimit: number;
	/** The newest message seen; null until the chat's newest seq was read (nothing older is pushed). */
	lastSeenSeq: number | null;
	createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One saved subscription, or undefined for an entry a hand edit broke. */
function parseSubscription(raw: unknown): InboxSubscription | undefined {
	if (!isRecord(raw)) return undefined;
	const { chatId, title, app, enabled, perHourLimit, lastSeenSeq, createdAt } = raw;
	if (typeof chatId !== "string" || !/^[1-9]\d{0,18}$/.test(chatId)) return undefined;
	const limit = typeof perHourLimit === "number" && Number.isInteger(perHourLimit) && perHourLimit >= 1 && perHourLimit <= MAX_PER_HOUR_LIMIT ? perHourLimit : DEFAULT_PER_HOUR_LIMIT;
	return {
		chatId,
		title: typeof title === "string" ? title : "",
		app: typeof app === "string" ? app : "",
		enabled: enabled === true,
		perHourLimit: limit,
		lastSeenSeq: typeof lastSeenSeq === "number" && Number.isSafeInteger(lastSeenSeq) && lastSeenSeq >= 0 ? lastSeenSeq : null,
		createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
	};
}

export class InboxStore {
	readonly file: string;

	constructor(
		dataDir: string,
		private readonly log: (line: string) => void = () => undefined,
	) {
		this.file = join(dataDir, CHAT_INBOX_FILE);
	}

	/** The saved subscriptions; none when the file is missing or cannot be read (said in the log). */
	load(): InboxSubscription[] {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log(`chat inbox: ${CHAT_INBOX_FILE} not read (${(err as Error).message})`);
			return [];
		}
		try {
			const raw = JSON.parse(text) as unknown;
			const list = isRecord(raw) && Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
			const seen = new Set<string>();
			const out: InboxSubscription[] = [];
			for (const entry of list) {
				const sub = parseSubscription(entry);
				if (!sub || seen.has(sub.chatId)) continue;
				seen.add(sub.chatId);
				out.push(sub);
			}
			return out;
		} catch (err) {
			this.log(`chat inbox: ${CHAT_INBOX_FILE} is not valid JSON, no chat is pushed (${(err as Error).message})`);
			return [];
		}
	}

	/** Writes every subscription, atomically and owner-only. */
	save(subscriptions: readonly InboxSubscription[]): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		writePrivateFile(this.file, `${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`);
	}
}
