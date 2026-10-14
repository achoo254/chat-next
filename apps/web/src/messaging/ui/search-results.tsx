// Local search results (core FTS over cached messages, accent-insensitive),
// shown in place of the chat list while the search box has text.
import { useEffect, useState } from "react";
import type { StoredMessage } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dialogTitle, listTime } from "../data/format.ts";
import { highlight } from "../data/highlight.ts";
import { useServices } from "../data/services.tsx";

const SEARCH_DELAY_MS = 80;

export default function SearchResults({ query }: { query: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { source, store } = useServices();
	const [result, setResult] = useState<{ query: string; hits: StoredMessage[] } | null>(null);

	useEffect(() => {
		let active = true;
		const timer = setTimeout(() => {
			source.search(query, { limit: 50 }).then(
				(hits) => {
					if (active) setResult({ query, hits });
				},
				() => {
					if (active) setResult({ query, hits: [] });
				},
			);
		}, SEARCH_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [source, query]);

	const open = (message: StoredMessage) => {
		store.openWindow(message.chatId, message.seq);
		navigate(paths.chat(message.chatId));
	};
	const hits = result?.hits ?? [];
	return (
		<div className="search-panel">
			<div className="search-note">{copy.search.note}</div>
			{result !== null && hits.length === 0 ? (
				<div className="empty">
					<Icon name="search" />
					<strong>{copy.search.emptyTitle}</strong>
					<span>{copy.search.emptyBody}</span>
				</div>
			) : (
				<ul className="results" aria-label={copy.search.results} aria-busy={result === null || result.query !== query}>
					{hits.map((message) => {
						const view = store.dialog(message.chatId);
						const title = view === undefined ? "" : dialogTitle(view, copy);
						return (
							<li key={`${message.chatId}:${message.seq}`}>
								<button type="button" className="result-row" onClick={() => open(message)}>
									<span className="r-head">
										<b>{title}</b>
										<span>{listTime(message.date, new Date(), locale, copy)}</span>
									</span>
									<span className="r-text">
										{highlight(message.text, query).map((segment, index) =>
											segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
