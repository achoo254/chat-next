// The chat's webhooks (mockups/integrations.html#hooks-list): name, format,
// creator, last request and status (running, rotating its secret, turned
// off or turned off by the server), then the chat's webhook log.
import { useEffect, useState } from "react";
import type { Chat } from "@app/core";
import { BrandLoader } from "../../components/brand-loader.tsx";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { HOOKS_PER_CHAT_MAX, type Hook, type HookNames } from "./api.ts";
import { HookAudit } from "./hook-audit.tsx";
import { formatLabel, HookAvatar, stateView, useNow, whenText } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

interface ListState {
	readonly hooks: readonly Hook[];
	readonly names: HookNames;
	readonly status: "loading" | "ready" | "error";
}

export function HookList({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations, store } = useServices();
	const [state, setState] = useState<ListState>({ hooks: [], names: new Map(), status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const now = useNow(false);
	const channel = chat.type === "channel";

	useEffect(() => {
		let active = true;
		integrations.hooks(chat.id).then(
			({ hooks, names }) => {
				if (active) setState({ hooks, names, status: "ready" });
			},
			() => {
				if (active) setState((current) => ({ ...current, status: "error" }));
			},
		);
		return () => {
			active = false;
		};
	}, [integrations, chat.id, attempt]);

	const nameOf = (userId: number) => (userId === store.selfId ? copy.common.you : (state.names.get(userId) ?? copy.message.unknownUser));
	const full = state.hooks.length >= HOOKS_PER_CHAT_MAX;
	return (
		<div className="hooks-body">
			<div className="hooks-title">
				<h2>{t.title(channel)}</h2>
				{state.status === "ready" && !full && (
					<Link to={paths.hookNew(chat.id)} className="btn btn-primary">
						<Icon name="plus" />
						{t.create}
					</Link>
				)}
			</div>
			{full && <p className="note">{t.limitReached(HOOKS_PER_CHAT_MAX)}</p>}
			{state.status === "loading" && (
				<BrandLoader label={copy.common.loading} />
			)}
			{state.status === "error" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.common.loadFailed}</span>
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => {
							setState((current) => ({ ...current, status: "loading" }));
							setAttempt((n) => n + 1);
						}}
					>
						{copy.common.retry}
					</button>
				</div>
			)}
			{state.status === "ready" && state.hooks.length === 0 && (
				<div className="card empty">
					<Icon name="webhook" />
					<strong>{t.emptyTitle}</strong>
					<span>{t.emptyBody(channel)}</span>
				</div>
			)}
			{state.hooks.length > 0 && (
				<div className="card table-card">
					<table className="data hook-table">
						<thead>
							<tr>
								<th scope="col">{t.columns.hook}</th>
								<th scope="col">{t.columns.format}</th>
								<th scope="col">{t.columns.creator}</th>
								<th scope="col">{t.columns.lastUsed}</th>
								<th scope="col">{t.columns.state}</th>
								<th scope="col">
									<span className="sr-only">{t.columns.actions}</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{state.hooks.map((hook) => {
								const view = stateView(hook, now, t, channel);
								return (
									<tr key={hook.id}>
										<td data-label={t.columns.hook}>
											<span className="hook-cell">
												<HookAvatar hook={hook} />
												<strong>{hook.name}</strong>
											</span>
										</td>
										<td data-label={t.columns.format}>
											<span className="fmt">{formatLabel(hook.format, t)}</span>
										</td>
										<td data-label={t.columns.creator}>{nameOf(hook.createdBy)}</td>
										<td data-label={t.columns.lastUsed}>{hook.lastUsedAt === 0 ? t.neverUsed : whenText(hook.lastUsedAt, now, locale, copy)}</td>
										<td data-label={t.columns.state}>
											<span className={`dot ${view.tone}`}>{view.label}</span>
											{view.sub !== "" && <span className="cell-sub">{view.sub}</span>}
										</td>
										<td className="actions-cell">
											<Link to={paths.hook(chat.id, hook.id)} className="btn btn-sm" aria-label={t.manageName(hook.name)}>
												{t.manage}
											</Link>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<p className="note">{t.membersNote(channel)}</p>
			<HookAudit chatId={chat.id} hookId="" />
		</div>
	);
}
