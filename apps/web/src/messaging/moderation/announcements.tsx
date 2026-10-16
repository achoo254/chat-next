// Operators' announcements (mockups/moderation.html#announce): write a
// message in the Bot API's markdown, see it as people will (the server
// parses it), confirm the number of recipients and send it through the
// assistant bot to everyone who started it. The list shows each
// announcement's progress, refreshed while one is being sent, and stops
// one on request.
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { listTime, orgDomain } from "../data/format.ts";
import type { Announcement, AnnouncementPreview } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import { RichText, type RichContext } from "../ui/rich-text.tsx";
import { useLoad } from "./use-load.ts";

/** Wait after typing before the server parses the text again. */
const PREVIEW_DELAY_MS = 400;
/** How often the list refreshes while an announcement is being sent. */
const REFRESH_MS = 3000;

const PILLS: Record<Announcement["state"], string> = { queued: "pill new", running: "pill review", done: "pill done", cancelled: "pill skip" };

/** Why sending failed, as the server says it (message prefix). */
function sendFailure(err: unknown, t: FullCopy["moderation"], fallback: string): string {
	const error = ConnectError.from(err);
	if (error.code === Code.FailedPrecondition && error.rawMessage.startsWith("no_recipients")) return t.announceNoRecipients;
	if (error.code === Code.FailedPrecondition && error.rawMessage.startsWith("busy")) return t.announceBusy;
	if (error.code === Code.InvalidArgument) return t.announceSyntax;
	return fallback;
}

export default function Announcements() {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts, self } = useServices();
	const t = copy.moderation;
	const [reload, setReload] = useState(0);
	const [list, retry] = useLoad(() => remote.announcements(), `announcements:${reload}`);
	const [text, setText] = useState("");
	const [preview, setPreview] = useState<{ text: string; value: AnnouncementPreview | null; error: string }>({ text: "", value: null, error: "" });
	const [invalid, setInvalid] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [stopping, setStopping] = useState<ReadonlySet<number>>(new Set());
	const id = useDomId("announce");
	const number = new Intl.NumberFormat(locale);
	const scope = orgDomain(window.location.host);

	// The server parses the text (markdown errors, the formatted preview).
	const draft = text.trim();
	useEffect(() => {
		if (draft === "") return;
		let active = true;
		const timer = setTimeout(() => {
			remote.previewAnnouncement(draft).then(
				(value) => active && setPreview({ text: draft, value, error: "" }),
				(err: unknown) => active && setPreview({ text: draft, value: null, error: sendFailure(err, t, copy.common.failed) }),
			);
		}, PREVIEW_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [draft, remote, t, copy.common.failed]);
	const current = draft !== "" && preview.text === draft ? preview : null;

	const items = list.status === "ready" ? list.value.items : [];
	const sending = items.some((item) => item.state === "queued" || item.state === "running");
	useEffect(() => {
		if (!sending) return;
		const timer = setTimeout(() => setReload((n) => n + 1), REFRESH_MS);
		return () => clearTimeout(timer);
	}, [sending, reload]);

	const audience = current?.value?.audience ?? (list.status === "ready" ? list.value.audience : 0);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (draft === "") {
			setInvalid(true);
			return;
		}
		if (current?.error) return;
		setConfirming(true);
	};
	const send = () => {
		setBusy(true);
		remote.sendAnnouncement(draft).then(
			() => {
				setBusy(false);
				setConfirming(false);
				setText("");
				setReload((n) => n + 1);
				toasts.show(t.announceQueued);
			},
			(err: unknown) => {
				setBusy(false);
				setConfirming(false);
				toasts.show(sendFailure(err, t, copy.common.failed));
			},
		);
	};
	const stop = (item: Announcement) => {
		setStopping((now) => new Set(now).add(item.id));
		const done = () =>
			setStopping((now) => {
				const next = new Set(now);
				next.delete(item.id);
				return next;
			});
		remote.cancelAnnouncement(item.id).then(
			() => {
				done();
				setReload((n) => n + 1);
				toasts.show(t.announceStopped);
			},
			() => {
				done();
				toasts.show(copy.common.failed);
			},
		);
	};
	// Links in a preview are not followed.
	const ctx: RichContext = { selfId: self.id, selfUsername: self.username, openLink: () => undefined };
	const now = new Date();
	const people = list.status === "ready" ? list.value.people : new Map();
	return (
		<>
			<header className="mod-head">
				<h1>{t.announcements}</h1>
				<span className="scope-lock hide-narrow">
					<Icon name="robot" small />
					{t.feedbackVia}
				</span>
			</header>
			<div className="mod-body flow">
				<form className="an-compose" onSubmit={submit} aria-labelledby={`${id}-title`}>
					<h2 id={`${id}-title`}>{t.announceNew}</h2>
					<div className="field">
						<label htmlFor={`${id}-text`}>
							{t.announceLabel} <span className="muted">{t.announceHint}</span>
						</label>
						<textarea
							id={`${id}-text`}
							className="input"
							rows={5}
							maxLength={8192}
							value={text}
							aria-invalid={invalid || (current?.error ?? "") !== ""}
							aria-describedby={invalid || current?.error ? `${id}-err` : undefined}
							onChange={(event) => {
								setText(event.target.value);
								if (event.target.value.trim() !== "") setInvalid(false);
							}}
						/>
						{(invalid || current?.error) && (
							<span className="error-text" id={`${id}-err`}>
								{invalid ? t.announceRequired : current?.error}
							</span>
						)}
					</div>
					{current?.value && (
						<div className="an-preview" aria-label={t.announcePreview}>
							<span className="an-preview-label muted">{t.announcePreview}</span>
							<div className="an-bubble rich">
								<RichText text={current.value.text} entities={current.value.entities} ctx={ctx} />
							</div>
						</div>
					)}
					<div className="an-foot">
						<span className="muted">{t.announceAudience(number.format(audience))}</span>
						<button type="submit" className="btn btn-primary" disabled={draft !== "" && (current === null || current.error !== "")}>
							<Icon name="megaphone" small />
							{t.announceSend}
						</button>
					</div>
				</form>
				<h2 className="an-list-title">{t.announceSentList}</h2>
				{list.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button type="button" className="btn btn-sm" onClick={retry}>
							{copy.common.retry}
						</button>
					</div>
				) : (
					<ul className="an-list" aria-busy={list.status === "loading"}>
						{items.map((item) => {
							const by = people.get(item.createdBy)?.name ?? copy.message.unknownUser;
							const active = item.state === "queued" || item.state === "running";
							const counts = [item.sent, item.skipped, item.failed].map((n) => number.format(n));
							return (
								<li className="an-item" key={item.id}>
									<div className="an-head">
										<span className={PILLS[item.state]}>{t.announceStates[item.state] ?? item.state}</span>
										<span className="an-time mono muted">{t.announceByWhen(listTime(item.createdAt, now, locale, copy), by)}</span>
										{active && (
											<button type="button" className="btn btn-sm" aria-busy={stopping.has(item.id)} disabled={stopping.has(item.id)} onClick={() => stop(item)}>
												{t.announceStop}
											</button>
										)}
									</div>
									<div className="an-text rich">
										<RichText text={item.text} entities={item.entities} ctx={ctx} />
									</div>
									{active && item.total > 0 && (
										<progress className="meter" max={item.total} value={Math.min(item.total, item.sent + item.skipped + item.failed)} />
									)}
									<span className="an-stats mono muted">
										{active
											? t.announceProgress(counts[0] ?? "0", number.format(item.total), counts[1] ?? "0", counts[2] ?? "0")
											: t.announceStats(counts[0] ?? "0", counts[1] ?? "0", counts[2] ?? "0")}
									</span>
								</li>
							);
						})}
						{list.status === "ready" && items.length === 0 && (
							<li>
								<div className="empty">
									<Icon name="megaphone" />
									<strong>{t.announceNone}</strong>
									<span>{t.announceNoneHint}</span>
								</div>
							</li>
						)}
					</ul>
				)}
			</div>
			{confirming && (
				<Modal labelledBy={`${id}-confirm`} onClose={() => setConfirming(false)}>
					<DialogHead id={`${id}-confirm`} title={t.announceConfirmTitle} onClose={() => setConfirming(false)} />
					<div className="dlg-body flow">
						<p>{t.announceConfirmBody(number.format(audience), scope)}</p>
					</div>
					<div className="dlg-foot">
						<button type="button" className="btn" onClick={() => setConfirming(false)}>
							{copy.common.cancel}
						</button>
						<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={send}>
							{t.announceConfirm(number.format(audience))}
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}
