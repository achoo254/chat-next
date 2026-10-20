// Media inside messages (mockups/media.html#message-media, #upload,
// #media-gone), loaded the first time a chat shows a file: photos and video
// posters in fixed boxes (the inline thumb shows at once, blurred, and the
// real image lands in the same box), albums, file cards, voice messages
// with a waveform, the upload state of your own sends (local preview,
// progress, cancel, retry) and the photo of a link preview. A message that
// is no longer available keeps its box and says so.
import type { MediaRef, MediaRequest, MediaSizeType, PendingMedia, PendingMessage, StoredMessage } from "@app/core";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { inlineThumbUrl } from "../data/format.ts";
import { useConnection, useItem, useServices } from "../data/services.tsx";
import { boxStyle, isVisual, mediaBox } from "./box.ts";
import { downloadMedia } from "./download.ts";
import { fileExt, formatBytes, formatDuration, formatProgress, percent, waveformBars } from "./media-format.ts";
import { MediaIcon } from "./media-icons.tsx";
import { viewer } from "./media-state.ts";
import { useMediaFile, useNearViewport, usePendingFileUrl, useUploadProgress } from "./use-media.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

const VOICE_BARS = 40;

/** Rendition of a picture in a bubble: M (800px) when the server made one, else the original. */
function bubbleSize(media: MediaRef): MediaSizeType | undefined {
	return media.sizes.some((size) => size.type === "m") ? "m" : undefined;
}

function cssVar(name: string, value: string): CSSProperties {
	return { [name]: value } as CSSProperties;
}

function mediaRequest(chatId: number, seq: number, media: MediaRef, size: MediaSizeType | undefined): MediaRequest {
	return { chatId, seq, fileId: media.fileId, kind: media.kind, ...(size === undefined ? {} : { size }) };
}

// ------------------------------------------------------------- pictures

interface PictureProps {
	chatId: number;
	seq: number;
	media: MediaRef;
	/** Rendition to show; by default M when the server made one. */
	size?: MediaSizeType | undefined;
	/** In an album the grid sizes the cell; alone the picture has its own fixed box. */
	cell?: boolean;
	label: string;
}

/** The image layers of a picture: blurred inline thumb, then the real image in the same place. */
function PictureLayers({ thumb, url }: { thumb: string; url: string | null }) {
	return (
		<>
			{thumb !== "" && <img className="pic-thumb" src={thumb} alt="" />}
			{url !== null && <img className="pic-full" src={url} alt="" decoding="async" />}
		</>
	);
}

function Gone({ style, compact = false }: { style?: CSSProperties | undefined; compact?: boolean }) {
	const copy = useMediaCopy();
	return (
		<div className="media-pic gone" style={style} role="img" aria-label={copy.media.gone}>
			<Icon name="eye-off" />
			<strong>{copy.media.gone}</strong>
			{!compact && <span>{copy.media.goneBody}</span>}
		</div>
	);
}

/** A photo, or a video's poster with a play button; opens the viewer. */
export function PictureView({ chatId, seq, media, size: wantedSize, cell = false, label }: PictureProps) {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const [ref, near] = useNearViewport();
	const video = media.kind === "video";
	// A video shows the server's poster (its M rendition) when there is one.
	const size = wantedSize ?? bubbleSize(media);
	const wanted = video && size === undefined ? null : mediaRequest(chatId, seq, media, size);
	const { state, retry } = useMediaFile(wanted, near);
	const style = cell ? undefined : boxStyle(mediaBox(media.width, media.height));
	if (state.status === "gone") return <Gone style={style} compact={cell} />;
	const loading = wanted !== null && state.status === "loading" && !video;
	return (
		<div ref={ref} className={video ? "media-pic video" : "media-pic"} style={style}>
			<PictureLayers thumb={inlineThumbUrl(media.inlineThumb)} url={state.status === "ok" ? state.url : null} />
			<button type="button" className="pic-open" aria-label={video ? copy.media.playVideo(media.duration) : label} onClick={() => viewer.set({ chatId, seq })}>
				{video && (
					<span className="round-btn" aria-hidden="true">
						<MediaIcon name="play" />
					</span>
				)}
			</button>
			{loading && (
				<span className="pic-state" aria-hidden="true">
					<span className="round-btn">
						<span className="spin" />
					</span>
				</span>
			)}
			{state.status === "failed" && (
				<span className="pic-state">
					<button type="button" className="btn btn-sm" onClick={retry}>
						{copy.media.retry}
					</button>
				</span>
			)}
			{video && (
				<span className="chip-on-media" aria-hidden="true">
					<MediaIcon name="video" small />
					{media.duration > 0 ? `${formatDuration(media.duration, true)} · ` : ""}
					{formatBytes(media.size, locale)}
				</span>
			)}
		</div>
	);
}

// ------------------------------------------------------------- file cards

export function FileCard({ chatId, seq, media }: { chatId: number; seq: number; media: MediaRef }) {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const { source, toasts } = useServices();
	const [gone, setGone] = useState(false);
	const [busy, setBusy] = useState(false);
	const name = media.fileName !== "" ? media.fileName : copy.media.downloadUnavailable;
	const ext = fileExt(media.fileName);
	const download = () => {
		setBusy(true);
		toasts.show(copy.media.downloading);
		downloadMedia(source, chatId, seq, media)
			.then(
				(ok) => setGone(!ok),
				() => toasts.show(copy.media.loadFailed),
			)
			.finally(() => setBusy(false));
	};
	return (
		<div className="file-card">
			<span className={gone ? "file-ext grey" : "file-ext"} aria-hidden="true">
				{ext}
			</span>
			<span className="fc-text">
				<b title={name}>{name}</b>
				<small>{gone ? copy.media.fileGone : copy.media.fileMeta(formatBytes(media.size, locale), ext)}</small>
			</span>
			<button
				type="button"
				className="icon-btn"
				aria-label={gone ? copy.media.downloadUnavailable : copy.media.download(name)}
				aria-busy={busy}
				disabled={gone || busy}
				onClick={download}
			>
				<MediaIcon name="download" />
			</button>
		</div>
	);
}

// ------------------------------------------------------------- voice

function VoicePlayer({ chatId, seq, media }: { chatId: number; seq: number; media: MediaRef }) {
	const copy = useMediaCopy();
	const { toasts } = useServices();
	const [ref, near] = useNearViewport();
	const { state } = useMediaFile(mediaRequest(chatId, seq, media, undefined), near);
	const audio = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);
	const [position, setPosition] = useState(0);
	const [length, setLength] = useState(media.duration / 1000);
	if (state.status === "gone") {
		return (
			<div className="voice gone-voice">
				<span className="play" aria-hidden="true">
					<Icon name="eye-off" />
				</span>
				<small>{copy.media.gone}</small>
			</div>
		);
	}
	const seconds = length > 0 ? length : media.duration / 1000;
	const bars = waveformBars(media.waveform, VOICE_BARS);
	const played = seconds > 0 ? Math.min(1, position / seconds) : 0;
	const toggle = () => {
		const element = audio.current;
		if (element === null || state.status !== "ok") return;
		if (!element.paused) {
			element.pause();
			return;
		}
		element.play().catch(() => toasts.show(copy.media.voiceFailed));
	};
	const seekTo = (fraction: number) => {
		const element = audio.current;
		if (element === null || !(seconds > 0)) return;
		element.currentTime = Math.max(0, Math.min(seconds, fraction * seconds));
		setPosition(element.currentTime);
	};
	const onWaveClick = (event: MouseEvent<HTMLSpanElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width > 0) seekTo((event.clientX - rect.left) / rect.width);
	};
	const onWaveKey = (event: KeyboardEvent<HTMLSpanElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		if (seconds > 0) seekTo((position + (event.key === "ArrowRight" ? 5 : -5)) / seconds);
	};
	return (
		<div ref={ref} className="voice">
			<button
				type="button"
				className="play"
				aria-label={playing ? copy.media.pauseVoice : copy.media.playVoice(seconds * 1000)}
				aria-pressed={playing}
				disabled={state.status !== "ok"}
				onClick={toggle}
			>
				{state.status === "loading" && near ? <span className="spin" aria-hidden="true" /> : <MediaIcon name={playing ? "pause" : "play"} />}
			</button>
			<span className="voice-body">
				<span
					className="wave"
					role="slider"
					tabIndex={0}
					aria-label={copy.media.seek}
					aria-valuemin={0}
					aria-valuemax={Math.round(seconds)}
					aria-valuenow={Math.round(position)}
					aria-valuetext={`${formatDuration(position * 1000)} / ${formatDuration(seconds * 1000)}`}
					onClick={onWaveClick}
					onKeyDown={onWaveKey}
				>
					{bars.map((height, index) => (
						<i key={index} className={index < Math.round(played * VOICE_BARS) ? "on" : undefined} style={{ height: `${Math.round(height * 100)}%` }} />
					))}
				</span>
				<small>
					<span>{playing || position > 0 ? `${formatDuration(position * 1000)} / ${formatDuration(seconds * 1000)}` : formatDuration(seconds * 1000)}</span>
					<span>{playing ? copy.media.playing : copy.media.voice}</span>
				</small>
			</span>
			{state.status === "ok" && (
				// eslint-disable-next-line jsx-a11y/media-has-caption -- a recorded voice message has no transcript or caption file to attach
				<audio
					ref={audio}
					src={state.url}
					preload="metadata"
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onEnded={() => {
						setPlaying(false);
						setPosition(0);
					}}
					onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
					onLoadedMetadata={(event) => {
						const duration = event.currentTarget.duration;
						if (Number.isFinite(duration) && duration > 0) setLength(duration);
					}}
					onError={() => setPlaying(false)}
				/>
			)}
		</div>
	);
}

// ------------------------------------------------------------- messages

/** The file of one message, by kind. */
export function MessageMedia({ message }: { message: StoredMessage }) {
	const copy = useMediaCopy();
	const media = message.media;
	if (media === undefined) return null;
	switch (media.kind) {
		case "photo":
		case "video":
			return <PictureView chatId={message.chatId} seq={message.seq} media={media} label={copy.media.open} />;
		case "voice":
		case "audio":
			return <VoicePlayer chatId={message.chatId} seq={message.seq} media={media} />;
		default:
			return <FileCard chatId={message.chatId} seq={message.seq} media={media} />;
	}
}

function AlbumCell({ chatId, itemKey, index }: { chatId: number; itemKey: string; index: number }) {
	const copy = useMediaCopy();
	const item = useItem(chatId, itemKey);
	if (item?.kind !== "message") return null;
	const media = item.message.media;
	if (media === undefined) return null;
	if (!isVisual(media)) return <MessageMedia message={item.message} />;
	return <PictureView chatId={chatId} seq={item.message.seq} media={media} cell label={copy.media.albumItem(index + 1, media.kind === "video")} />;
}

/** Messages sent together (same grouped_id): photos and videos in a grid, files and audio stacked. */
export function AlbumMedia({ chatId, keys, visual }: { chatId: number; keys: readonly string[]; visual: boolean }) {
	const copy = useMediaCopy();
	const cells = keys.map((key, index) => <AlbumCell key={key} chatId={chatId} itemKey={key} index={index} />);
	if (!visual) return <div className="file-stack">{cells}</div>;
	return (
		<div className={`album n${Math.min(keys.length, 5)}`} role="group" aria-label={copy.media.album(keys.length)}>
			{cells}
		</div>
	);
}

// ------------------------------------------------------------- uploads

interface UploadView {
	readonly pct: number;
	readonly text: string;
	readonly failed: boolean;
	readonly waiting: boolean;
	readonly paused: boolean;
}

function useUploadView(pending: PendingMessage, media: PendingMedia): UploadView {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const progress = useUploadProgress(media.uploadKey);
	const connection = useConnection();
	const failed = pending.failure !== null || progress?.state === "failed";
	const paused = !failed && progress?.state === "paused";
	const waiting = !failed && !paused && (connection === "offline" || connection === "waiting");
	// No upload row: the file is stored and the message is on its way.
	const sent = progress === null ? media.size : progress.sentBytes;
	const total = progress === null ? media.size : progress.totalBytes;
	const pct = percent(sent, total);
	let text = `${formatProgress(sent, total, locale)} · ${pct}%`;
	if (failed) text = `${copy.upload.failed} · ${formatBytes(total, locale)}`;
	else if (paused) text = `${copy.upload.paused} · ${formatProgress(sent, total, locale)}`;
	else if (waiting) text = `${copy.upload.waiting} · ${formatProgress(sent, total, locale)}`;
	else if (progress !== null && (progress.state === "queued" || progress.state === "hashing") && sent === 0) text = copy.upload.preparing;
	return { pct, text, failed, waiting, paused };
}

/** Retry after a failure, cancel while offline, otherwise pause or resume (mockups/media.html#upload); cancel is also in the message menu. */
function UploadActions({ pending, media, view, round }: { pending: PendingMessage; media: PendingMedia; view: UploadView; round: boolean }) {
	const copy = useMediaCopy();
	const { source, toasts } = useServices();
	if (view.failed) {
		const retry = () => {
			toasts.show(copy.upload.retrying);
			source.retryOutbox(pending.outboxId).catch(() => toasts.show(copy.tray.sendFailed));
		};
		return round ? (
			<button type="button" className="round-btn" aria-label={copy.upload.retry} onClick={retry}>
				<Icon name="upload" />
			</button>
		) : (
			<button type="button" className="btn btn-sm" onClick={retry}>
				{copy.upload.retry}
			</button>
		);
	}
	if (view.waiting) {
		const cancel = () => {
			source.discardOutbox(pending.outboxId).then(
				() => toasts.show(copy.upload.cancelled),
				() => toasts.show(copy.tray.sendFailed),
			);
		};
		return (
			<button type="button" className={round ? "round-btn" : "icon-btn"} aria-label={copy.upload.cancel} onClick={cancel}>
				<Icon name="x" />
			</button>
		);
	}
	const toggle = () => {
		const done = view.paused ? source.resumeUpload(media.uploadKey) : source.pauseUpload(media.uploadKey);
		done.then(
			() => toasts.show(view.paused ? copy.upload.resumedToast : copy.upload.pausedToast),
			() => toasts.show(copy.tray.sendFailed),
		);
	};
	return (
		<button type="button" className={round ? "round-btn" : "icon-btn"} aria-label={view.paused ? copy.upload.resume : copy.upload.pause} onClick={toggle}>
			{view.paused ? <Icon name="upload" /> : <MediaIcon name="pause" />}
		</button>
	);
}

function ProgressBar({ view, label }: { view: UploadView; label: string }) {
	return (
		<span
			className={view.failed ? "up-bar failed" : view.waiting ? "up-bar waiting" : view.paused ? "up-bar paused" : "up-bar"}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={view.pct}
		>
			<span style={{ width: `${view.pct}%` }} />
		</span>
	);
}

/** A photo or video being uploaded: the local picture, a progress ring with cancel, or retry after a failure. */
function PendingPicture({ pending, media, cell = false }: { pending: PendingMessage; media: PendingMedia; cell?: boolean }) {
	const copy = useMediaCopy();
	const view = useUploadView(pending, media);
	const local = usePendingFileUrl(media.uploadKey, media.kind === "photo");
	const style = cell ? undefined : boxStyle(mediaBox(media.width, media.height));
	return (
		<div className={media.kind === "video" ? "media-pic video up" : "media-pic up"} style={style}>
			<PictureLayers thumb={inlineThumbUrl(media.inlineThumb)} url={local} />
			<span className="pic-state">
				{view.failed ? (
					<UploadActions pending={pending} media={media} view={view} round />
				) : (
					<span
						className="ring"
						style={cssVar("--p", String(view.pct))}
						role="progressbar"
						aria-label={media.kind === "video" ? copy.upload.video : copy.upload.photo}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={view.pct}
					>
						<UploadActions pending={pending} media={media} view={view} round />
					</span>
				)}
			</span>
			<span className={view.failed ? "chip-on-media top err" : "chip-on-media top"}>{view.text}</span>
		</div>
	);
}

/** A file or voice message being uploaded: a card with a progress bar, cancel or retry. */
function PendingCard({ pending, media }: { pending: PendingMessage; media: PendingMedia }) {
	const copy = useMediaCopy();
	const view = useUploadView(pending, media);
	const voice = media.kind === "voice";
	const name = voice ? copy.media.voice : media.fileName;
	return (
		<div className="file-card">
			<span className={view.failed ? "file-ext grey" : "file-ext"} aria-hidden="true">
				{voice ? <Icon name="mic" /> : fileExt(media.fileName)}
			</span>
			<span className="fc-text">
				<b title={name}>{name}</b>
				<small className={view.failed ? "err-text" : view.waiting ? "warn-text" : undefined}>
					{view.waiting && <Icon name="wifi-off" small />}
					{view.text}
				</small>
				{!view.failed && <ProgressBar view={view} label={copy.upload.progress} />}
			</span>
			<UploadActions pending={pending} media={media} view={view} round={false} />
		</div>
	);
}

/** Your own media send while it uploads. */
export function PendingMediaView({ pending }: { pending: PendingMessage }) {
	const media = pending.media;
	if (media === undefined) return null;
	return isVisual(media) ? <PendingPicture pending={pending} media={media} /> : <PendingCard pending={pending} media={media} />;
}

function PendingCell({ chatId, itemKey }: { chatId: number; itemKey: string }) {
	const item = useItem(chatId, itemKey);
	if (item?.kind !== "pending" || item.pending.media === undefined) return null;
	const media = item.pending.media;
	return isVisual(media) ? <PendingPicture pending={item.pending} media={media} cell /> : <PendingCard pending={item.pending} media={media} />;
}

/** An album being uploaded (pending messages of one outbox entry). */
export function PendingAlbumMedia({ chatId, keys, visual }: { chatId: number; keys: readonly string[]; visual: boolean }) {
	const copy = useMediaCopy();
	const cells = keys.map((key) => <PendingCell key={key} chatId={chatId} itemKey={key} />);
	if (!visual) return <div className="file-stack">{cells}</div>;
	return (
		<div className={`album n${Math.min(keys.length, 5)}`} role="group" aria-label={copy.media.album(keys.length)}>
			{cells}
		</div>
	);
}

// ------------------------------------------------------------- link previews

/** The page's image in a link preview card (a server-owned photo fetched in the message's context). */
export function LinkPhoto({ message }: { message: StoredMessage }): ReactNode {
	const copy = useMediaCopy();
	const photo = message.linkPreview?.photo;
	const [ref, near] = useNearViewport();
	const size = photo?.sizes.some((s) => s.type === "s") === true ? "s" : undefined;
	const { state } = useMediaFile(photo === undefined ? null : mediaRequest(message.chatId, message.seq, photo, size), near);
	if (photo === undefined || state.status === "gone" || state.status === "failed") return null;
	const thumb = inlineThumbUrl(photo.inlineThumb);
	return (
		<span ref={ref} className="thumb" role="img" aria-label={copy.media.linkPhoto}>
			<PictureLayers thumb={thumb} url={state.status === "ok" ? state.url : null} />
		</span>
	);
}
