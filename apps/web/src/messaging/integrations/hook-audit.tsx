// Webhook log (GetIncomingHookAudit): who created, rotated, turned off or
// on, took over or deleted a webhook, and when the server turned one off.
// The whole chat's log on the list (deleted webhooks included), one
// webhook's on its page; newest first, a page at a time.
import type { ReactNode } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import type { HookAuditEntry } from "./api.ts";
import { usePaged, useNow, whenText } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

const AUDIT_PAGE = 20;

/** Names arrive with each page, so each entry keeps its actor's name ("" when the server sent none). */
type Named = HookAuditEntry & { readonly actorName: string };

export function HookAudit({ chatId, hookId }: { chatId: number; hookId: string }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations, store } = useServices();
	const now = useNow(false);
	const id = `audit-${chatId}-${hookId}`;
	const actorOf = (entry: Named) =>
		entry.actorId === 0 ? t.audit.server : entry.actorId === store.selfId ? copy.common.you : entry.actorName || copy.message.unknownUser;
	const page = usePaged<Named>(
		`${chatId}:${hookId}`,
		AUDIT_PAGE,
		async (beforeId) => {
			const { entries, names } = await integrations.audit(chatId, hookId, beforeId, AUDIT_PAGE);
			return entries.map((entry) => ({ ...entry, actorName: names.get(entry.actorId) ?? "" }));
		},
		(entry) => entry.id,
	);
	let body: ReactNode;
	if (page.status === "loading") body = <p className="status">{copy.common.loading}</p>;
	else if (page.status === "error") {
		body = (
			<p className="status bad">
				{copy.common.loadFailed}{" "}
				<button type="button" className="btn btn-sm" onClick={page.reload}>
					{copy.common.retry}
				</button>
			</p>
		);
	} else if (page.items.length === 0) body = <p className="note">{t.audit.empty}</p>;
	else {
		body = (
			<ul className="audit-list">
				{page.items.map((entry) => (
					<li key={entry.id}>
						<span>{t.audit.action(entry.action, actorOf(entry), entry.hookName, entry.detail)}</span>
						<time dateTime={new Date(entry.date * 1000).toISOString()}>{whenText(entry.date, now, locale, copy)}</time>
					</li>
				))}
			</ul>
		);
	}
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{t.audit.title}</h3>
			{hookId === "" && <p>{t.audit.chatNote}</p>}
			{body}
			{page.more && (
				<button type="button" className="see-all" onClick={page.loadMore}>
					{t.detail.more}
				</button>
			)}
		</section>
	);
}
