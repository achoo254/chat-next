// Photo and video viewer (mockups/media.html#viewer, #media-gone): dark,
// over the whole window. Sender and time, zoom, download, forward, close
// (Esc). ← → (keys, buttons, or a swipe on touch screens) move through the
// photos and videos of the chat that are loaded; an album's pictures are
// in a strip below. Videos stream from short-lived URLs with the browser's
// controls (asking for a new URL once when one expired). A message deleted
// for everyone while it is open says so instead of retrying.
import type { MediaRef, StoredMessage } from "@app/core";
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type TouchEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { clock, shortDate } from "../data/format.ts";
import { useItem, useMessage, useServices, useUser, useWindow } from "../data/services.tsx";
import { messageKey } from "../data/store.ts";
import { Modal } from "../ui/parts.tsx";
import { useUi } from "../ui/ui-context.tsx";
import { downloadMedia } from "./download.ts";
import { MediaIcon } from "./media-icons.tsx";
import { inlineThumbUrl, useMediaFile } from "./use-media.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.5;
/** A horizontal touch move this long (px) goes to the next or previous picture. */
const SWIPE_PX = 50;

function isViewable(message: StoredMessage): boolean {
	return !message.recalled && (message.media?.kind === "photo" || message.media?.kind === "video");
}

/** The pictures a viewer can move through: photos and videos of the loaded messages, oldest first. */
export function viewableMessages(messages: readonly StoredMessage[]): StoredMessage[] {
	return messages.filter(isViewable);
}

/** Frame of a picture fitted into the stage (a size container) with its aspect ratio. */
function frameStyle(media: MediaRef, zoom: number, pan: { x: number; y: number }): CSSProperties {
	const ratio = media.width > 0 && media.height > 0 ? media.width / media.height : 4 / 3;
	return {
		aspectRatio: `${ratio}`,
		width: `min(100cqw, ${(ratio * 100).toFixed(3)}cqh)`,
		transform: zoom === 1 ? undefined : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
	};
}

function Photo({ message, media, zoom, pan }: { message: StoredMessage; media: MediaRef; zoom: number; pan: { x: number; y: number } }) {
	const copy = useMediaCopy();
	const size = media.sizes.some((s) => s.type === "x") ? "x" : undefined;
	const { state, retry } = useMediaFile({ chatId: message.chatId, seq: message.seq, fileId: media.fileId, kind: media.kind, ...(size === undefined ? {} : { size }) });
	if (state.status === "gone") return <GoneView message={message} />;
	const thumb = inlineThumbUrl(media.inlineThumb);
	return (
		<span className="v-frame" style={frameStyle(media, zoom, pan)} role="img" aria-label={message.text !== "" ? message.text : copy.media.photo}>
			{thumb !== "" && <img className="pic-thumb" src={thumb} alt="" />}
			{state.status === "ok" && <img src={state.url} alt="" draggable={false} />}
			{state.status === "loading" && (
				<span className="pic-state" aria-hidden="true">
					<span className="spin" />
				</span>
			)}
			{state.status === "failed" && (
				<span className="pic-state">
					<button type="button" className="btn" onClick={retry}>
						{copy.media.retry}
					</button>
				</span>
			)}
		</span>
	);
}

function Video({ message, media }: { message: StoredMessage; media: MediaRef }) {
	const copy = useMediaCopy();
	const { source, store } = useServices();
	const [url, setUrl] = useState<{ readonly seq: number; readonly value: string | null; readonly refreshed: boolean } | null>(null);
	const [failed, setFailed] = useState(false);
	const request = { chatId: message.chatId, seq: message.seq, fileId: media.fileId, kind: media.kind };
	const ask = (refresh: boolean) => {
		source.mediaUrl(request, refresh).then(
			(signed) => setUrl({ seq: message.seq, value: signed?.url ?? null, refreshed: refresh }),
			(err: unknown) => {
				store.reportError(err, `video ${message.chatId}:${message.seq}`);
				setFailed(true);
			},
		);
	};
	const askFirst = useEffectEvent(() => ask(false));
	useEffect(() => {
		askFirst();
	}, [message.seq]);
	if (url !== null && url.seq === message.seq && url.value === null) return <GoneView message={message} />;
	if (failed) return <p className="v-gone">{copy.viewer.videoFailed}</p>;
	if (url === null || url.seq !== message.seq) return <span className="spin" aria-hidden="true" />;
	return (
		<video
			key={url.value}
			src={url.value ?? undefined}
			controls
			autoPlay
			playsInline
			aria-label={message.text !== "" ? message.text : copy.media.video}
			onError={() => {
				// An expired URL answers 403: ask for a fresh one once, then give up.
				if (url.refreshed) setFailed(true);
				else ask(true);
			}}
		/>
	);
}

function GoneView({ message }: { message: StoredMessage | null }) {
	const copy = useMediaCopy();
	const sender = useUser(message?.fromId ?? 0);
	return (
		<div className="v-gone" role="status">
			<Icon name="eye-off" />
			<strong>{copy.media.gone}</strong>
			<span>{copy.viewer.goneBody(sender?.name ?? copy.media.photo)}</span>
		</div>
	);
}

interface ViewerProps {
	chatId: number;
	seq: number;
	onClose: () => void;
}

export default function Viewer({ chatId, seq: startSeq, onClose }: ViewerProps) {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const { store, source, toasts } = useServices();
	const ui = useUi();
	useWindow(chatId);
	const [seq, setSeq] = useState(startSeq);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
	const touch = useRef<number | null>(null);
	const id = "media-viewer-title";

	const messages = store.items(chatId).flatMap((item) => (item.kind === "message" ? [item.message] : []));
	const list = viewableMessages(messages);
	const lookedUp = useMessage(chatId, seq);
	const inWindow = messages.find((message) => message.seq === seq);
	// Follows the open message itself: deleted for everyone while open, it turns into "gone".
	const item = useItem(chatId, inWindow === undefined ? "" : messageKey(inWindow));
	const current = (item?.kind === "message" ? item.message : inWindow) ?? lookedUp ?? null;
	const index = list.findIndex((message) => message.seq === seq);
	const sender = useUser(current?.fromId ?? 0);
	const gone = current === null || !isViewable(current);
	const media = gone ? undefined : current.media;
	const album = current !== null && current.groupedId !== 0 ? list.filter((message) => message.groupedId === current.groupedId && message.fromId === current.fromId) : [];

	const go = (next: StoredMessage | undefined) => {
		if (next === undefined) return;
		setSeq(next.seq);
		setZoom(1);
		setPan({ x: 0, y: 0 });
	};
	const step = (delta: number) => go(index < 0 ? undefined : list[index + delta]);
	const zoomBy = (delta: number) => {
		const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
		setZoom(next);
		if (next === 1) setPan({ x: 0, y: 0 });
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target instanceof HTMLVideoElement) return;
		if (event.key === "ArrowLeft") step(-1);
		else if (event.key === "ArrowRight") step(1);
		else if ((event.key === "+" || event.key === "=") && media?.kind === "photo") zoomBy(ZOOM_STEP);
		else if (event.key === "-" && media?.kind === "photo") zoomBy(-ZOOM_STEP);
		else return;
		event.preventDefault();
	};

	// Touch: a horizontal swipe moves to the next or previous picture (not while zoomed in).
	const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
		touch.current = zoom === 1 ? (event.changedTouches[0]?.clientX ?? null) : null;
	};
	const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
		const start = touch.current;
		touch.current = null;
		const end = event.changedTouches[0]?.clientX;
		if (start === null || end === undefined) return;
		if (end - start > SWIPE_PX) step(-1);
		else if (start - end > SWIPE_PX) step(1);
	};
	// Zoomed in, dragging moves the picture.
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (zoom === 1 || event.pointerType === "touch") return;
		drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = drag.current;
		if (start === null) return;
		setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
	};
	const onPointerUp = () => {
		drag.current = null;
	};

	const download = () => {
		if (current === null || media === undefined) return;
		toasts.show(copy.media.downloading);
		downloadMedia(source, chatId, current.seq, media).catch(() => toasts.show(copy.media.loadFailed));
	};
	const forward = () => {
		if (current === null) return;
		onClose();
		ui.dialog.set({ kind: "forward", chatId, seq: current.seq });
	};

	const when = current === null ? "" : copy.viewer.at(shortDate(current.date, locale), clock(current.date, locale));
	return (
		<Modal labelledBy={id} onClose={onClose} className="viewer">
			<div className="v-top" onKeyDown={onKeyDown}>
				<div className="who">
					<strong id={id}>{current?.fromId === store.selfId ? (sender?.name ?? "") : (sender?.name ?? (media?.kind === "video" ? copy.viewer.videoLabel : copy.viewer.label))}</strong>
					<span>{when}</span>
				</div>
				{media?.kind === "photo" && (
					<>
						<button type="button" className="icon-btn" aria-label={copy.viewer.zoomOut} disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(-ZOOM_STEP)}>
							<MediaIcon name="zoom-out" />
						</button>
						<span className="v-zoom" aria-live="polite">
							{copy.viewer.zoom(Math.round(zoom * 100))}
						</span>
						<button type="button" className="icon-btn" aria-label={copy.viewer.zoomIn} disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
							<MediaIcon name="zoom-in" />
						</button>
					</>
				)}
				{media !== undefined && (
					<>
						<button type="button" className="icon-btn" aria-label={copy.viewer.download} onClick={download}>
							<MediaIcon name="download" />
						</button>
						<button type="button" className="icon-btn" aria-label={copy.viewer.forward} onClick={forward}>
							<Icon name="forward" />
						</button>
					</>
				)}
				<button type="button" className="icon-btn" aria-label={copy.viewer.close} onClick={onClose}>
					<Icon name="x" />
				</button>
			</div>
			<div
				className={zoom > 1 ? "v-stage zoomed" : "v-stage"}
				tabIndex={-1}
				onKeyDown={onKeyDown}
				onTouchStart={onTouchStart}
				onTouchEnd={onTouchEnd}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onDoubleClick={() => {
					if (media?.kind === "photo") zoomBy(zoom > 1 ? -ZOOM_MAX : 1);
				}}
			>
				{current === null || media === undefined ? (
					<GoneView message={current} />
				) : media.kind === "video" ? (
					<Video message={current} media={media} />
				) : (
					<Photo message={current} media={media} zoom={zoom} pan={pan} />
				)}
				{index > 0 && (
					<button type="button" className="icon-btn v-nav prev" aria-label={copy.viewer.prev} onClick={() => step(-1)}>
						<MediaIcon name="chevron-left" />
					</button>
				)}
				{index >= 0 && index < list.length - 1 && (
					<button type="button" className="icon-btn v-nav next" aria-label={copy.viewer.next} onClick={() => step(1)}>
						<MediaIcon name="chevron-right" />
					</button>
				)}
			</div>
			<div className="v-bottom" onKeyDown={onKeyDown}>
				{current !== null && current.text !== "" && !gone && <p>{current.text}</p>}
				<span className="count">{gone ? copy.viewer.goneCount : index >= 0 ? copy.viewer.counter(index + 1, list.length) : ""}</span>
				{album.length > 1 && (
					<div className="v-strip" role="group" aria-label={copy.viewer.strip}>
						{album.map((message, position) => {
							const thumb = message.media === undefined ? "" : inlineThumbUrl(message.media.inlineThumb);
							return (
								<button
									key={message.seq}
									type="button"
									aria-label={copy.media.albumItem(position + 1, message.media?.kind === "video")}
									aria-current={message.seq === seq}
									onClick={() => go(message)}
								>
									{thumb !== "" && <img src={thumb} alt="" />}
								</button>
							);
						})}
					</div>
				)}
			</div>
		</Modal>
	);
}
