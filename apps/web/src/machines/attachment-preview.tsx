// A file of the composer's tray or an image of a sent message, looked at
// without leaving the session: an image whole, a PDF in the browser's viewer,
// text as text (never run: an HTML file shows its source), audio and video
// with their controls; anything else names itself and offers to download.
import { useEffect, useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { fileExt, formatBytes } from "../messaging/media/media-format.ts";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** What the preview shows: a URL the page holds (an object URL) and, for text, the file to read. */
export interface PreviewTarget {
	readonly name: string;
	/** Bytes; 0 when unknown. */
	readonly size: number;
	readonly url: string;
	readonly image: boolean;
	readonly file?: File | undefined;
}

export type PreviewKind = "image" | "pdf" | "text" | "video" | "audio" | "none";

/** Text read for the preview, at most this many bytes. */
const TEXT_MAX_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set(
	"txt md markdown log csv tsv json jsonl yaml yml toml ini env xml html htm css scss js jsx ts tsx mjs cjs py rb go rs java kt swift c h cpp hpp cs php sh zsh bash sql vue svelte diff patch".split(
		" ",
	),
);

/** How a file shows in the preview, by its type and else its extension. */
export function previewKind(name: string, type: string, image: boolean): PreviewKind {
	const dot = name.lastIndexOf(".");
	const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
	if (image || type.startsWith("image/")) return "image";
	if (type === "application/pdf" || ext === "pdf") return "pdf";
	if (type.startsWith("video/")) return "video";
	if (type.startsWith("audio/")) return "audio";
	if (type.startsWith("text/") || type === "application/json" || type === "application/xml" || TEXT_EXTENSIONS.has(ext)) return "text";
	return "none";
}

/** The start of a text file, read once the preview opens. */
function useText(file: File | undefined, wanted: boolean): { text: string | null; cut: boolean; failed: boolean } {
	const [state, setState] = useState<{ text: string | null; failed: boolean }>({
		text: null,
		failed: false,
	});
	useEffect(() => {
		if (!wanted || file === undefined) return;
		let live = true;
		file
			.slice(0, TEXT_MAX_BYTES)
			.text()
			.then(
				(text) => live && setState({ text, failed: false }),
				() => live && setState({ text: null, failed: true }),
			);
		return () => {
			live = false;
		};
	}, [file, wanted]);
	return { ...state, cut: file !== undefined && file.size > TEXT_MAX_BYTES };
}

export function AttachmentPreview({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const id = useDomId("attachment-preview");
	const kind = previewKind(target.name, target.file?.type ?? "", target.image);
	const text = useText(target.file, kind === "text");
	let body;
	switch (kind) {
		case "image":
			body = <img className="mx-preview-img" src={target.url} alt={target.name} />;
			break;
		case "pdf":
			body = <iframe className="mx-preview-frame" src={target.url} title={target.name} />;
			break;
		case "video":
			// eslint-disable-next-line jsx-a11y/media-has-caption -- a file the user attaches comes with no caption file
			body = <video className="mx-preview-media" src={target.url} controls />;
			break;
		case "audio":
			// eslint-disable-next-line jsx-a11y/media-has-caption -- a file the user attaches comes with no caption file
			body = <audio src={target.url} controls />;
			break;
		case "text":
			body = text.failed ? (
				<p className="muted">{t.agent.attach.previewNone}</p>
			) : text.text === null ? (
				<span className="spin" aria-hidden="true" />
			) : (
				<>
					<pre className="mx-preview-text">{text.text}</pre>
					{text.cut && <p className="muted">{t.agent.attach.previewCut(formatBytes(TEXT_MAX_BYTES, locale))}</p>}
				</>
			);
			break;
		default:
			body = (
				<div className="mx-preview-none">
					<span className="mx-tray-file" aria-hidden="true">
						{fileExt(target.name)}
					</span>
					<p className="muted">{t.agent.attach.previewNone}</p>
				</div>
			);
	}
	return (
		<Modal labelledBy={id} onClose={onClose} className="large mx-preview">
			<DialogHead id={id} title={target.name} onClose={onClose} />
			<div className="dlg-body mx-preview-body" data-kind={kind}>
				{body}
			</div>
			<div className="dlg-foot">
				{target.size > 0 && <span className="muted mx-preview-size">{formatBytes(target.size, locale)}</span>}
				<a className="btn" href={target.url} download={target.name}>
					<Icon name="download" small />
					<span>{t.agent.attach.download}</span>
				</a>
			</div>
		</Modal>
	);
}
