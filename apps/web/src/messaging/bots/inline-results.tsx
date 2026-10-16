// Inline mode of bots (mockups/bots.html#inline-mode): with "@bot_username "
// at the start of the draft, the bot's hint shows above the composer; with a
// query after it, the bot's results (a list of articles, or a grid of media
// when the bot asks for one). Picking one posts it as the user's message
// "via" the bot and clears the draft. Bots without inline mode, and
// usernames of people, show nothing. Loaded with the first such draft.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cryptoRandomId } from "@app/platform";
import { Icon } from "../../components/icon.tsx";
import { inlineThumbUrl } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { useMediaFile } from "../media/use-media.ts";
import { botErrorKind, type BotInfo, type InlineAnswer, type InlineItem } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./inline-results.css";

/** Wait after the last keystroke before asking the bot. */
const QUERY_DELAY_MS = 400;

/** "@bot_username query": inline mode of that bot. */
const DRAFT = /^@([A-Za-z0-9_]{5,32}) ([^]*)$/;

/** Bots looked up by username in this session (null: no bot with inline mode). */
const resolved = new Map<string, Promise<BotInfo | null>>();

/** What the results answer: the bot, the chat and the query. */
type Asked = { readonly query: string; readonly botId: number; readonly chatId: number };

type Results = Asked &
	(
		| { readonly status: "loading" }
		| { readonly status: "ready"; readonly answer: InlineAnswer }
		| { readonly status: "timeout" }
		| { readonly status: "failed" }
	);

interface InlineResultsProps {
	chatId: number;
	topicId: number;
	/** The composer's draft, starting with "@". */
	draft: string;
	/** The result was posted: the draft is cleared. */
	onSent: () => void;
}

export default function InlineResults({ chatId, topicId, draft, onSent }: InlineResultsProps) {
	const t = useBotsCopy().inline;
	const { bots, toasts } = useServices();
	const match = DRAFT.exec(draft);
	const name = match?.[1]?.toLowerCase() ?? "";
	const query = match?.[2] ?? "";
	const [bot, setBot] = useState<{ name: string; info: BotInfo | null } | null>(null);
	const [results, setResults] = useState<Results | null>(null);
	const [sending, setSending] = useState("");
	// Set at once (state updates later): a double click sends once.
	const busy = useRef(false);

	useEffect(() => {
		if (name === "") return;
		let active = true;
		let lookup = resolved.get(name);
		if (lookup === undefined) {
			lookup = bots.resolve(name).then(
				(info) => (info !== null && info.inlinePlaceholder !== "" ? info : null),
				() => {
					resolved.delete(name);
					return null;
				},
			);
			resolved.set(name, lookup);
		}
		void lookup.then((info) => active && setBot({ name, info }));
		return () => {
			active = false;
		};
	}, [bots, name]);

	const info = name !== "" && bot?.name === name ? bot.info : null;
	const trimmed = query.trim();
	useEffect(() => {
		if (info === null || trimmed === "") return;
		let active = true;
		const asked = { query: trimmed, botId: info.id, chatId };
		const timer = setTimeout(() => {
			setResults({ ...asked, status: "loading" });
			bots.inlineQuery(info.id, chatId, trimmed).then(
				(answer) => active && setResults({ ...asked, status: "ready", answer }),
				(err: unknown) => active && setResults({ ...asked, status: botErrorKind(err) === "bot_timeout" ? "timeout" : "failed" }),
			);
		}, QUERY_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [bots, info, chatId, trimmed]);

	if (info === null) return null;
	const current = results !== null && results.query === trimmed && results.botId === info.id && results.chatId === chatId ? results : null;
	const pick = (answer: InlineAnswer, item: InlineItem) => {
		if (busy.current) return;
		busy.current = true;
		setSending(item.id);
		bots.sendInlineResult(chatId, topicId, answer.queryId, item.id, cryptoRandomId()).then(
			() => {
				busy.current = false;
				setSending("");
				onSent();
			},
			() => {
				busy.current = false;
				setSending("");
				toasts.show(t.sendFailed);
			},
		);
	};
	const body = (): ReactNode => {
		if (trimmed === "") {
			return (
				<p className="inline-hint">
					{info.inlinePlaceholder}
					<small className="muted">{t.disclosure(info.username)}</small>
				</p>
			);
		}
		switch (current?.status) {
			case undefined:
			case "loading":
				return <p className="inline-hint muted">{t.loading}</p>;
			case "timeout":
				return <p className="inline-hint muted">{t.timeout}</p>;
			case "failed":
				return <p className="inline-hint muted">{t.failed}</p>;
			case "ready":
				break;
		}
		const answer = current.answer;
		if (answer.items.length === 0) return <p className="inline-hint muted">{t.empty(trimmed)}</p>;
		if (answer.gallery) {
			return (
				<div className="inline-grid">
					{answer.items.map((item) => (
						<button
							key={item.id}
							type="button"
							aria-label={item.title || item.description || item.kind}
							aria-busy={sending === item.id}
							onClick={() => pick(answer, item)}
						>
							<Thumb queryId={answer.queryId} item={item} />
						</button>
					))}
				</div>
			);
		}
		return (
			<ul className="inline-list">
				{answer.items.map((item) => (
					<li key={item.id}>
						<button type="button" aria-busy={sending === item.id} onClick={() => pick(answer, item)}>
							{(item.thumbnail ?? item.media) !== undefined && <Thumb queryId={answer.queryId} item={item} small />}
							<span className="inline-text">
								<b>{item.title || item.media?.fileName || item.kind}</b>
								{item.description !== "" && <span>{item.description}</span>}
							</span>
						</button>
					</li>
				))}
			</ul>
		);
	};
	const heading = current?.status === "loading" ? t.asking(info.username) : t.from(info.username);
	return (
		<div className="inline-results" role="region" aria-label={heading} aria-live="polite">
			<div className="inline-head">
				<Icon name="robot" small />
				<span>{heading}</span>
			</div>
			{body()}
		</div>
	);
}

/** A result's picture: its photo (a video's poster), or an article's thumbnail; the inline thumb until it loads. */
function Thumb({ queryId, item, small = false }: { queryId: string; item: InlineItem; small?: boolean }) {
	const ref = item.thumbnail ?? item.media;
	const picture = ref !== undefined && (ref.kind === "photo" || ref.kind === "video");
	const { state } = useMediaFile(
		picture && ref !== undefined
			? { chatId: 0, seq: 0, fileId: ref.fileId, inlineQueryId: queryId, kind: ref.kind, ...(ref.sizes.some((s) => s.type === "s") ? { size: "s" as const } : {}) }
			: null,
	);
	const src = state.status === "ok" ? state.url : ref === undefined ? "" : inlineThumbUrl(ref.inlineThumb);
	return (
		<span className={small ? "thumb sm" : "thumb"} aria-hidden="true">
			{src !== "" && <img src={src} alt="" />}
			{!picture && <Icon name="file" />}
		</span>
	);
}
