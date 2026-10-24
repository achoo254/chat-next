// Files waiting in the composer (mockups/media.html#attach, #upload): each
// picked, dropped or pasted file with a preview, its size and a remove
// button; files the server would refuse (over the upload limit, empty) are
// named in an alert and left out of the send. The composer's text becomes
// the caption; "Gửi dạng file" sends photos and videos uncompressed.
import type { MediaLimits } from "@achoo254/chat-core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCell } from "../ui/ui-context.tsx";
import { attachments, sendAsFiles } from "./media-state.ts";
import { fileExt, formatBytes, planSends, sendKind } from "./media-format.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

const previews = new WeakMap<File, string>();

/** An object URL of a picked image, kept while the file waits in the tray. */
function previewUrl(file: File): string {
	let url = previews.get(file);
	if (url === undefined) {
		url = URL.createObjectURL(file);
		previews.set(file, url);
	}
	return url;
}

/** Revokes the previews of files that left the tray (sent or removed). */
export function releasePreviews(files: readonly File[]): void {
	for (const file of files) {
		const url = previews.get(file);
		if (url === undefined) continue;
		URL.revokeObjectURL(url);
		previews.delete(file);
	}
}

interface AttachTrayProps {
	chatId: number;
	topicId: number;
	limits: Pick<MediaLimits, "uploadSizeMax" | "albumSizeMax">;
}

export default function AttachTray({ chatId, topicId, limits }: AttachTrayProps) {
	const copy = useMediaCopy();
	const { locale } = useI18n();
	const cell = attachments(chatId, topicId);
	const files = useCell(cell);
	const asFilesCell = sendAsFiles(chatId, topicId);
	const asFiles = useCell(asFilesCell);
	if (files.length === 0) return null;
	const plan = planSends(files, limits, asFiles);
	const refused = new Set(plan.refused.map((entry) => entry.file));
	const accepted = files.filter((file) => !refused.has(file));
	const visual = accepted.some((file) => sendKind(file) !== "document");
	const album = plan.groups.some((group) => group.length > 1);
	const max = formatBytes(limits.uploadSizeMax, locale);
	const remove = (file: File) => {
		releasePreviews([file]);
		cell.set(cell.get().filter((other) => other !== file));
	};
	return (
		<div className="attach-tray" role="group" aria-label={copy.tray.label}>
			{plan.refused.map(({ file, problem }, index) => (
				<div className="banner error" role="alert" key={`${index}:${file.name}`}>
					<Icon name="alert" small />
					<span className="grow">
						{problem === "empty" ? copy.tray.empty(file.name) : copy.tray.tooLarge(file.name, formatBytes(file.size, locale), max)}
					</span>
					<button type="button" className="icon-btn" aria-label={copy.tray.dismiss} onClick={() => remove(file)}>
						<Icon name="x" small />
					</button>
				</div>
			))}
			{accepted.length > 0 && (
				<>
					<div className="tray-head">
						<span>{copy.tray.count(accepted.length, album)}</span>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								releasePreviews(files);
								cell.set([]);
							}}
						>
							{copy.tray.clear}
						</button>
					</div>
					<ul className="tray-list">
						{accepted.map((file, index) => {
							const image = sendKind(file) === "photo";
							return (
								<li className="tray-item" key={`${index}:${file.name}:${file.size}`}>
									{image ? (
										<span className="tray-pic">
											<img src={previewUrl(file)} alt="" />
										</span>
									) : (
										<span className="file-ext" aria-hidden="true">
											{fileExt(file.name)}
										</span>
									)}
									<span>
										<b title={file.name}>{file.name}</b>
										<small>{formatBytes(file.size, locale)}</small>
									</span>
									<button type="button" className="icon-btn" aria-label={copy.tray.remove(file.name)} onClick={() => remove(file)}>
										<Icon name="x" small />
									</button>
								</li>
							);
						})}
					</ul>
					{visual && (
						<div className="tray-opts">
							<label>
								<input type="checkbox" checked={asFiles} onChange={(event) => asFilesCell.set(event.target.checked)} />
								{copy.tray.asFiles}
							</label>
						</div>
					)}
				</>
			)}
		</div>
	);
}
