// Users banned from a group or channel (mockups/chat.html#banned), opened
// from the admin page. Only "Xoá và cấm vào lại" puts someone here. Unbanning
// lifts the ban only: the person is not added back, but invite links and
// being added work for them again. Admins only.
import { useEffect, useState } from "react";
import { BrandLoader } from "../../components/brand-loader.tsx";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { shortDate } from "../data/format.ts";
import type { BannedMember } from "../data/remote.ts";
import { useChat, useServices } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";

interface BannedState {
	readonly items: readonly BannedMember[];
	readonly cursor: string;
	readonly status: "loading" | "ready" | "error";
}

/** 10/10/2026 (Vietnamese ICU builds differ on separators, see shortDate). */
function fullDate(unixSeconds: number, locale: string): string {
	if (locale === "vi") return `${shortDate(unixSeconds, locale)}/${new Date(unixSeconds * 1000).getFullYear()}`;
	return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(unixSeconds * 1000);
}

export function BannedList({ chatId }: { chatId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, store, toasts } = useServices();
	const chat = useChat(chatId);
	const [state, setState] = useState<BannedState>({ items: [], cursor: "", status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [busy, setBusy] = useState(0);
	const t = copy.banned;
	const admin = chat?.myRole === "admin" || chat?.myRole === "owner";

	useEffect(() => {
		if (!admin) return;
		let active = true;
		remote.bannedMembers(chatId).then(
			(page) => {
				if (active) setState({ items: page.items, cursor: page.nextCursor, status: "ready" });
			},
			() => {
				if (active) setState({ items: [], cursor: "", status: "error" });
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, admin, attempt]);

	const more = () => {
		remote.bannedMembers(chatId, state.cursor).then(
			(page) => {
				setState((current) => {
					const seen = new Set(current.items.map((item) => item.person.id));
					return { ...current, items: [...current.items, ...page.items.filter((item) => !seen.has(item.person.id))], cursor: page.nextCursor };
				});
			},
			() => toasts.show(copy.common.failed),
		);
	};

	const unban = (item: BannedMember) => {
		setBusy(item.person.id);
		remote.unbanMember(chatId, item.person.id).then(
			() => {
				setBusy(0);
				setState((current) => ({ ...current, items: current.items.filter((other) => other.person.id !== item.person.id) }));
				toasts.show(t.unbanned(item.person.name));
			},
			() => {
				setBusy(0);
				toasts.show(copy.common.failed);
			},
		);
	};

	if (chat == null) {
		return (
			<section className="admin-page">
				{chat === undefined ? <BrandLoader /> : <div className="empty">{copy.convo.notFound}</div>}
			</section>
		);
	}
	const channel = chat.type === "channel";
	const titleId = `banned-${chatId}`;
	return (
		<section className="admin-page" aria-labelledby={titleId}>
			<div className="admin-head">
				<Link to={paths.chatAdmin(chatId)} className="icon-btn" aria-label={t.back(channel)}>
					<Icon name="back" />
				</Link>
				<div className="title">
					<strong id={titleId}>{t.title(state.items.length, state.cursor !== "")}</strong>
					<span>{copy.admin.sub(chat.title, chat.memberCount, channel)}</span>
				</div>
			</div>
			{!admin ? (
				<div className="empty">{copy.admin.notAdmin}</div>
			) : (
				<div className="ban-page">
					<div className="card">
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
										setState({ items: [], cursor: "", status: "loading" });
										setAttempt((n) => n + 1);
									}}
								>
									{copy.common.retry}
								</button>
							</div>
						)}
						{state.status === "ready" && state.items.length === 0 && (
							<div className="empty">
								<Icon name="ban" />
								<strong>{t.emptyTitle}</strong>
								<span>{t.emptyBody(channel)}</span>
							</div>
						)}
						{state.items.length > 0 && (
							<ul className="ban-list">
								{state.items.map((item) => {
									const by = item.bannedBy === store.selfId ? t.byYou : item.bannedByName === "" ? t.byAdmin : item.bannedByName;
									const working = busy === item.person.id;
									return (
										<li className="row" key={item.person.id}>
											<ChatAvatar id={item.person.id} name={item.person.name} bot={item.person.isBot} />
											<span className="grow">
												{item.person.name}
												<small>{t.detail(item.person.username, by, fullDate(item.bannedAt, locale))}</small>
											</span>
											<button
												type="button"
												className="btn btn-compact"
												aria-label={working ? undefined : t.unbanName(item.person.name)}
												aria-busy={working}
												disabled={busy !== 0}
												onClick={() => unban(item)}
											>
												{working ? t.unbanning : t.unban}
											</button>
										</li>
									);
								})}
							</ul>
						)}
						{state.cursor !== "" && (
							<button type="button" className="see-all pad-x" onClick={more}>
								{t.more}
							</button>
						)}
					</div>
					<p className="note">
						<Icon name="info" />
						<span>{t.note(channel)}</span>
					</p>
				</div>
			)}
		</section>
	);
}
