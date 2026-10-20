// Shared media of a chat in the info column (mockups/chat.html#info-panels
// "Ảnh, file, link", mockups/media.html#shared-media): a section with one
// row per kind that the chat has (photos and videos, files, links), and a
// view with a tab per kind present: a photo grid by month (videos with
// their length), files with size and date, links with their site. There is
// no server index of a chat's media yet, so they are collected from the
// latest messages (SCAN_PAGES pages of history) and refreshed when the
// chat's history changes.
import { EventKeys, type MessageEntity, type StoredMessage } from "@app/core";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { hostOf, shortDate } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import type { ChatSource } from "../data/source.ts";
import { isAllowedLink, linkOpener } from "../ui/rich-text.tsx";
import { useUi } from "../ui/ui-context.tsx";
import { downloadMedia } from "./download.ts";
import { fileExt, formatBytes } from "./media-format.ts";
import { MediaIcon } from "./media-icons.tsx";
import { PictureView } from "./media-content.tsx";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

const SCAN_PAGE = 200;
const SCAN_PAGES = 3;
const REFRESH_DELAY_MS = 500;

export type SharedTab = "photos" | "files" | "links";

export interface SharedLink {
	readonly url: string;
	readonly title: string;
	readonly host: string;
	readonly seq: number;
	readonly fromId: number;
}

export interface Shared {
	/** Newest first. */
	readonly photos: readonly StoredMessage[];
	readonly files: readonly StoredMessage[];
	readonly links: readonly SharedLink[];
	/** Messages looked through. */
	readonly scanned: number;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/gi;

function linksOf(message: StoredMessage): string[] {
	const found: string[] = [];
	const slice = (entity: MessageEntity) => message.text.slice(entity.offset, entity.offset + entity.length);
	for (const entity of message.entities) {
		if (entity.type === "text_link" && entity.url !== undefined) found.push(entity.url);
		else if (entity.type === "url") found.push(slice(entity));
	}
	if (found.length === 0) for (const match of message.text.matchAll(URL_IN_TEXT)) found.push(match[0]);
	if (message.linkPreview !== null) found.push(message.linkPreview.url);
	return found.map((url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`)).filter(isAllowedLink);
}

/** Photos, videos, files and links of messages (any order), newest first, links once each. */
export function collectShared(messages: readonly StoredMessage[]): Omit<Shared, "scanned"> {
	const newest = [...messages].filter((m) => !m.recalled && m.action === null).sort((a, b) => b.seq - a.seq);
	const photos: StoredMessage[] = [];
	const files: StoredMessage[] = [];
	const links: SharedLink[] = [];
	const seen = new Set<string>();
	for (const message of newest) {
		const kind = message.media?.kind;
		if (kind === "photo" || kind === "video") photos.push(message);
		else if (kind === "document" || kind === "audio" || kind === "unknown") files.push(message);
		for (const url of linksOf(message)) {
			if (seen.has(url)) continue;
			seen.add(url);
			const preview = message.linkPreview?.url === url ? message.linkPreview : null;
			const host = hostOf(url);
			links.push({ url, title: preview !== null && preview.title !== "" ? preview.title : host, host, seq: message.seq, fromId: message.fromId });
		}
	}
	return { photos, files, links };
}

async function scan(source: ChatSource, chatId: number): Promise<Shared> {
	const messages: StoredMessage[] = [];
	let offsetSeq = 0;
	for (let page = 0; page < SCAN_PAGES; page++) {
		const view = await source.history(chatId, { direction: "older", offsetSeq, limit: SCAN_PAGE });
		messages.push(...view.messages);
		const first = view.messages[0]?.seq ?? 0;
		if (!view.hasOlder || first <= 1) break;
		offsetSeq = first;
	}
	return { ...collectShared(messages), scanned: messages.length };
}

/** The chat's shared media, scanned once and again (debounced) when its history changes. */
export function useShared(chatId: number): Shared | null {
	const { source, store } = useServices();
	const [result, setResult] = useState<{ readonly chatId: number; readonly shared: Shared } | null>(null);
	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = () => {
			scan(source, chatId).then(
				(shared) => {
					if (active) setResult({ chatId, shared });
				},
				(err: unknown) => store.reportError(err, `shared media ${chatId}`),
			);
		};
		run();
		const stop = source.events.subscribe(EventKeys.history(chatId), () => {
			clearTimeout(timer);
			timer = setTimeout(run, REFRESH_DELAY_MS);
		});
		return () => {
			active = false;
			clearTimeout(timer);
			stop();
		};
	}, [source, store, chatId]);
	return result !== null && result.chatId === chatId ? result.shared : null;
}

/** The info column's "Ảnh, file, link" rows, only for kinds the chat has; nothing when it has none. */
export function SharedMediaSection({ chatId, onOpen }: { chatId: number; onOpen: (tab: SharedTab) => void }) {
	const copy = useMediaCopy();
	const shared = useShared(chatId);
	if (shared === null || shared.photos.length + shared.files.length + shared.links.length === 0) return null;
	const rows: { tab: SharedTab; icon: "photo" | "file" | "link"; label: string; count: number }[] = [
		{ tab: "photos", icon: "photo", label: copy.shared.photos, count: shared.photos.length },
		{ tab: "files", icon: "file", label: copy.shared.files, count: shared.files.length },
		{ tab: "links", icon: "link", label: copy.shared.links, count: shared.links.length },
	];
	return (
		<div className="info-sec media-rows">
			<h3>{copy.shared.section}</h3>
			{rows
				.filter((row) => row.count > 0)
				.map((row) => (
					<button key={row.tab} type="button" className="row link-row" onClick={() => onOpen(row.tab)}>
						<Icon name={row.icon} />
						<span className="grow">{row.label}</span>
						<span className="num">{row.count}</span>
					</button>
				))}
		</div>
	);
}

function PhotoGrid({ chatId, photos }: { chatId: number; photos: readonly StoredMessage[] }) {
	const copy = useMediaCopy();
	const now = new Date();
	const months: { key: string; label: string; items: StoredMessage[] }[] = [];
	for (const message of photos) {
		const date = new Date(message.date * 1000);
		const key = `${date.getFullYear()}-${date.getMonth()}`;
		let month = months[months.length - 1];
		if (month === undefined || month.key !== key) {
			month = { key, label: copy.shared.month(date.getMonth() + 1, date.getFullYear(), date.getFullYear() === now.getFullYear()), items: [] };
			months.push(month);
		}
		month.items.push(message);
	}
	return (
		<>
			{months.map((month) => (
				<section key={month.key} aria-label={month.label}>
					<h4>{month.label}</h4>
					<div className="grid3">
						{month.items.map((message) =>
							message.media === undefined ? null : (
								<PictureView
									key={message.seq}
									chatId={chatId}
									seq={message.seq}
									media={message.media}
									size={message.media.sizes.some((s) => s.type === "s") ? "s" : undefined}
									cell
									label={message.media.kind === "video" ? copy.media.playVideo(message.media.duration) : copy.media.open}
								/>
							),
						)}
					</div>
				</section>
			))}
		</>
	);
}

function FileRows({ chatId, files }: { chatId: number; files: readonly StoredMessage[] }) {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const { source, toasts } = useServices();
	return (
		<ul className="sm-list">
			{files.map((message) => {
				const media = message.media;
				if (media === undefined) return null;
				return (
					<li key={message.seq} className="sm-row">
						<span className="file-ext" aria-hidden="true">
							{fileExt(media.fileName)}
						</span>
						<span>
							<b title={media.fileName}>{media.fileName}</b>
							<small>{copy.shared.fileLine(formatBytes(media.size, locale), shortDate(message.date, locale))}</small>
						</span>
						<button
							type="button"
							className="icon-btn"
							aria-label={copy.media.download(media.fileName)}
							onClick={() => {
								toasts.show(copy.media.downloading);
								downloadMedia(source, chatId, message.seq, media).then(
									(ok) => {
										if (!ok) toasts.show(copy.media.fileGone);
									},
									() => toasts.show(copy.media.loadFailed),
								);
							}}
						>
							<MediaIcon name="download" />
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function LinkRows({ links }: { links: readonly SharedLink[] }) {
	const copy = useMediaCopy();
	const ui = useUi();
	return (
		<ul className="sm-list">
			{links.map((link) => {
				const open = linkOpener((url, text) => ui.dialog.set({ kind: "link", url, text, fromId: link.fromId }));
				return (
					<li key={link.url}>
						<a
							className="sm-row"
							href={link.url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={copy.shared.openLink(link.host)}
							onClick={(event) => {
								event.preventDefault();
								open(link.url);
							}}
						>
							<span className="link-tile" aria-hidden="true">
								<Icon name="globe" />
							</span>
							<span>
								<b>{link.title}</b>
								<small className="domain">{link.host}</small>
							</span>
						</a>
					</li>
				);
			})}
		</ul>
	);
}

/** The shared media view (#shared-media): tabs for the kinds the chat has. */
export function SharedMediaView({ chatId, tab, onBack }: { chatId: number; tab: SharedTab; onBack: () => void }) {
	const copy = useMediaCopy();
	const shared = useShared(chatId);
	const [chosen, setChosen] = useState<SharedTab>(tab);
	const tabs: { key: SharedTab; label: string; count: number }[] = [
		{ key: "photos" as const, label: copy.shared.tabPhotos, count: shared?.photos.length ?? 0 },
		{ key: "files" as const, label: copy.shared.tabFiles, count: shared?.files.length ?? 0 },
		{ key: "links" as const, label: copy.shared.tabLinks, count: shared?.links.length ?? 0 },
	].filter((entry) => entry.count > 0);
	const active = tabs.some((entry) => entry.key === chosen) ? chosen : (tabs[0]?.key ?? chosen);
	const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const index = tabs.findIndex((entry) => entry.key === active);
		const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
		if (next === undefined) return;
		setChosen(next.key);
		document.getElementById(`sm-${chatId}-${next.key}-tab`)?.focus();
	};
	return (
		<>
			<div className="info-head">
				<button type="button" className="icon-btn" aria-label={copy.shared.back} onClick={onBack}>
					<Icon name="back" />
				</button>
				<span>{copy.shared.title}</span>
			</div>
			{shared === null ? (
				<p className="sm-body note" role="status">
					{copy.shared.loading}
				</p>
			) : (
				<>
					{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex: the selected tab holds focus, the tablist only receives its arrow keys */}
					<div className="tabs" role="tablist" aria-label={copy.shared.tabs} onKeyDown={onTabKey}>
						{tabs.map((entry) => (
							<button
								key={entry.key}
								id={`sm-${chatId}-${entry.key}-tab`}
								type="button"
								role="tab"
								aria-selected={entry.key === active}
								aria-controls={`sm-${chatId}-panel`}
								tabIndex={entry.key === active ? 0 : -1}
								onClick={() => setChosen(entry.key)}
							>
								{entry.label}
							</button>
						))}
					</div>
					<div className="sm-body" id={`sm-${chatId}-panel`} role="tabpanel" aria-labelledby={`sm-${chatId}-${active}-tab`}>
						{active === "photos" && <PhotoGrid chatId={chatId} photos={shared.photos} />}
						{active === "files" && <FileRows chatId={chatId} files={shared.files} />}
						{active === "links" && <LinkRows links={shared.links} />}
						<p className="note">{copy.shared.scanned(shared.scanned)}</p>
					</div>
				</>
			)}
		</>
	);
}

