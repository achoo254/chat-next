// Webhook log (GetIncomingHookAudit): who created, edited, rotated, turned off or
// on, took over or deleted a webhook, and when the server turned one off.
// The whole chat's log on the list (deleted webhooks included), one
// webhook's on its page; newest first, a page at a time.
import type { ReactNode } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import type { HookAuditEntry, HookChanges } from "./api.ts";
import { usePaged, useNow, whenText } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

const AUDIT_PAGE = 20;

// The server writes `name (was "<old>")` with Go's %q quoting (JSON-compatible
// for printable text), then `allow_alert on|off` and `silent on|off`.
const RENAMED = /^name \(was ("(?:[^"\\]|\\.)*")\)(?:, |$)/;

function unquote(quoted: string): string {
	try {
		const value: unknown = JSON.parse(quoted);
		if (typeof value === "string") return value;
	} catch {
		// Escapes JSON does not know (\x..): show the text between the quotes.
	}
	return quoted.slice(1, -1);
}

/** Reads the detail of an "updated" audit entry; unknown parts are ignored. */
export function parseHookChanges(detail: string): HookChanges {
	let rest = detail;
	let renamedFrom: string | null = null;
	const renamed = RENAMED.exec(rest);
	if (renamed?.[1] !== undefined) {
		renamedFrom = unquote(renamed[1]);
		rest = rest.slice(renamed[0].length);
	}
	let allowAlert: boolean | null = null;
	let silent: boolean | null = null;
	for (const part of rest.split(", ")) {
		const [setting, state] = part.split(" ");
		if (state !== "on" && state !== "off") continue;
		if (setting === "allow_alert") allowAlert = state === "on";
		if (setting === "silent") silent = state === "on";
	}
	return { renamedFrom, allowAlert, silent };
}

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
						<span>
							{entry.action === "updated"
								? t.audit.updated(actorOf(entry), entry.hookName, parseHookChanges(entry.detail))
								: t.audit.action(entry.action, actorOf(entry), entry.hookName, entry.detail)}
						</span>
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
