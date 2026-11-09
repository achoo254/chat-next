// What files look like around the AI session: the attach button (a phone
// also offers the camera), the tray of files waiting in the composer (a
// preview or a file card, upload progress, remove, try again), the drop zone
// shown while files are dragged over the session, and the files of a sent
// message in the thread (images fetched again from the machine over the
// end-to-end encrypted link when no preview is kept here).
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { fileExt, formatBytes } from "../messaging/media/media-format.ts";
import { fetchPreview, knownPreview, type UploadLink } from "./attachments.ts";
import type { ShownAttachment } from "./transcript/tool-fold.ts";
import type { Attachments } from "./use-attachments.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

/** Whether the main pointer is a finger (a phone or tablet): the camera is offered then. */
function coarsePointer(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * The browser reads copied images on request. A phone needs this: Safari on
 * iPhone offers "Paste" in a text field only for copied text, so a copied
 * image never reaches the composer's paste handler.
 */
function canReadClipboard(): boolean {
	return typeof navigator.clipboard?.read === "function";
}

/** The images among the clipboard's items, as files. */
export async function clipboardImages(items: readonly ClipboardItem[]): Promise<File[]> {
	const images: File[] = [];
	for (const item of items) {
		const type = item.types.find((x) => x.startsWith("image/"));
		if (type === undefined) continue;
		const blob = await item.getType(type);
		images.push(new File([blob], `image.${type.slice("image/".length)}`, { type }));
	}
	return images;
}

/** Files dragged in from the system (not text or a link). */
export function dragHasFiles(types: readonly string[]): boolean {
	return types.includes("Files");
}

/**
 * Drag handlers for an area that takes dropped files: `dragging` is true
 * while files are over it (children entering and leaving included).
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);
	const files = (event: DragEvent<HTMLElement>) => dragHasFiles([...event.dataTransfer.types]);
	const handlers = enabled
		? {
				onDragEnter: (event: DragEvent<HTMLElement>) => {
					if (!files(event)) return;
					event.preventDefault();
					depth.current += 1;
					setDragging(true);
				},
				onDragOver: (event: DragEvent<HTMLElement>) => {
					if (!files(event)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				},
				onDragLeave: () => {
					depth.current = Math.max(0, depth.current - 1);
					if (depth.current === 0) setDragging(false);
				},
				onDrop: (event: DragEvent<HTMLElement>) => {
					if (!files(event)) return;
					event.preventDefault();
					depth.current = 0;
					setDragging(false);
					onFiles([...event.dataTransfer.files]);
				},
			}
		: {};
	return { dragging: enabled && dragging, handlers };
}

export function AttachButton({ attach, disabled }: { attach: Attachments; disabled: boolean }) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const photos = useRef<HTMLInputElement>(null);
	const camera = useRef<HTMLInputElement>(null);
	const files = useRef<HTMLInputElement>(null);
	const pick = (input: HTMLInputElement | null) => {
		setOpen(false);
		input?.click();
	};
	const paste = () => {
		setOpen(false);
		// Called straight from the tap: Safari only reads the clipboard inside a user gesture.
		navigator.clipboard
			.read()
			.then(clipboardImages)
			.then(
				(images) => {
					if (images.length > 0) attach.add(images);
					else attach.say(t.agent.attach.pasteEmpty);
				},
				() => {
					attach.say(t.agent.attach.pasteDenied);
				},
			);
	};
	const onPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
		const picked = [...(event.target.files ?? [])];
		// The same file may be picked again later.
		event.target.value = "";
		attach.add(picked);
	};
	return (
		<div className="mx-attach" ref={ref}>
			<button
				type="button"
				className="icon-btn mx-attach-btn"
				aria-label={t.agent.attach.button}
				title={t.agent.attach.button}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
			>
				<Icon name="clip" />
			</button>
			{open && (
				<div className="mx-menu up mx-attach-menu" role="menu" aria-label={t.agent.attach.button}>
					{coarsePointer() && canReadClipboard() && (
						<button type="button" role="menuitem" onClick={paste}>
							<Icon name="copy" small />
							<span>{t.agent.attach.paste}</span>
						</button>
					)}
					<button type="button" role="menuitem" onClick={() => pick(photos.current)}>
						<Icon name="photo" small />
						<span>{t.agent.attach.photos}</span>
					</button>
					{coarsePointer() && (
						<button type="button" role="menuitem" onClick={() => pick(camera.current)}>
							<Icon name="camera" small />
							<span>{t.agent.attach.camera}</span>
						</button>
					)}
					<button type="button" role="menuitem" onClick={() => pick(files.current)}>
						<Icon name="file" small />
						<span>{t.agent.attach.files}</span>
					</button>
				</div>
			)}
			<input ref={photos} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="attach-photos" />
			<input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} />
			<input ref={files} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="attach-files" />
		</div>
	);
}

export function AttachTray({ attach }: { attach: Attachments }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	if (attach.items.length === 0 && attach.notice === "") return null;
	return (
		<div className="mx-tray" role="group" aria-label={t.agent.attach.tray}>
			{attach.notice !== "" && (
				<p className="mx-tray-notice" role="alert">
					<span>{attach.notice}</span>
					<button type="button" className="icon-btn" aria-label={t.agent.attach.dismiss} onClick={attach.dismiss}>
						<Icon name="x" small />
					</button>
				</p>
			)}
			{attach.items.length > 0 && (
				<ul className="mx-tray-list">
					{attach.items.map((item) => {
						const percent = item.size > 0 ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 100;
						return (
							<li key={item.id} className={`mx-tray-item ${item.state}`} data-image={item.image ? "" : undefined}>
								{item.image && item.preview !== "" ? (
									<img className="mx-tray-thumb" src={item.preview} alt="" />
								) : (
									<span className="mx-tray-file" aria-hidden="true">
										{item.state === "preparing" ? <Icon name="photo" small /> : fileExt(item.name)}
									</span>
								)}
								<span className="mx-tray-text">
									<b title={item.name}>{item.name}</b>
									<small>
										{item.state === "preparing"
											? t.agent.attach.preparing
											: item.state === "uploading"
												? t.agent.attach.uploading(percent)
												: item.state === "failed"
													? item.error || t.agent.attach.failed
													: formatBytes(item.size, locale)}
									</small>
								</span>
								{item.state === "uploading" && (
									<span className="mx-tray-bar" role="progressbar" aria-label={item.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
										<i style={{ width: `${percent}%` }} />
									</span>
								)}
								{item.state === "failed" && (
									<button type="button" className="btn btn-sm" onClick={() => attach.retry(item.id)}>
										{t.agent.attach.retry}
									</button>
								)}
								<button
									type="button"
									className="icon-btn mx-tray-remove"
									aria-label={item.state === "uploading" ? t.agent.attach.cancel(item.name) : t.agent.attach.remove(item.name)}
									title={item.state === "uploading" ? t.agent.attach.cancel(item.name) : t.agent.attach.remove(item.name)}
									onClick={() => attach.remove(item.id)}
								>
									<Icon name="x" small />
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/** Shown over the session while files are dragged over it. */
export function DropZone({ ai, maxBytes, supported }: { ai: string; maxBytes: number; supported: boolean }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	return (
		<div className="mx-drop" role="status">
			<Icon name="upload" />
			<strong>{supported ? t.agent.attach.dropTitle : t.agent.attach.dropOld}</strong>
			<span>{supported ? t.agent.attach.dropBody(ai, formatBytes(maxBytes, locale)) : t.agent.attach.needsUpdate}</span>
		</div>
	);
}

/** An image of a sent message: the preview kept here, else fetched from the machine when shown. */
function SentImage({ link, threadId, file }: { link: UploadLink; threadId: string; file: ShownAttachment }) {
	const t = useMachinesCopy();
	const [url, setUrl] = useState(() => file.preview || knownPreview(threadId, file.id) || "");
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (url !== "" || file.id === "") return;
		let live = true;
		fetchPreview(link, threadId, file.id).then(
			(next) => live && setUrl(next),
			() => live && setFailed(true),
		);
		return () => {
			live = false;
		};
	}, [url, link, threadId, file.id]);
	if (url === "") {
		return (
			<span className="mx-sent-img placeholder" role="img" aria-label={failed ? t.agent.attach.imageFailed(file.name) : t.agent.attach.imageLoading(file.name)}>
				<Icon name="photo" />
			</span>
		);
	}
	return (
		<a className="mx-sent-img" href={url} target="_blank" rel="noreferrer" title={file.name}>
			<img src={url} alt={file.name} />
		</a>
	);
}

/** The files of a user message in the thread. */
export function MessageAttachments({ link, threadId, files }: { link: UploadLink; threadId: string; files: readonly ShownAttachment[] }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const images = files.filter((f) => f.image);
	const others = files.filter((f) => !f.image);
	return (
		<div className="mx-sent-files">
			{images.length > 0 && (
				<div className="mx-sent-imgs">
					{images.map((f) => (
						<SentImage key={f.id} link={link} threadId={threadId} file={f} />
					))}
				</div>
			)}
			{others.map((f) => (
				<div key={f.id} className="mx-sent-file" title={f.path === "" ? f.name : t.agent.attach.savedAt(f.path)}>
					<span className="mx-tray-file" aria-hidden="true">
						{fileExt(f.name)}
					</span>
					<span className="mx-tray-text">
						<b>{f.name}</b>
						<small className={f.path === "" ? undefined : "mono"}>{f.path === "" ? formatBytes(f.size, locale) : f.path}</small>
					</span>
				</div>
			))}
		</div>
	);
}
