// The composer's attach menu (mockups/media.html #attach): photos and
// videos, any file up to the server's limit, and — where the browser can
// share the screen — a screenshot or a screen recording. Loaded when first opened.
import type { RefObject } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { altKeyLabel } from "../media/screen-share.ts";
import { PopupMenu } from "./popup-menu.tsx";

interface AttachMenuProps {
	boundary: RefObject<HTMLElement | null>;
	/** "tối đa 2 GB" as the composer words it. */
	limit: string;
	onMedia: () => void;
	onFiles: () => void;
	/** Shown where the browser can share the screen. */
	onScreenshot?: (() => void) | undefined;
	/** Shown where the browser can also record it. */
	onRecordScreen?: (() => void) | undefined;
	onClose: () => void;
}

export default function AttachMenu({ boundary, limit, onMedia, onFiles, onScreenshot, onRecordScreen, onClose }: AttachMenuProps) {
	const copy = useScreensCopy();
	return (
		<PopupMenu className="attach-menu" label={copy.composer.attachMenu} boundary={boundary} onClose={onClose}>
			<button type="button" role="menuitem" onClick={onMedia}>
				<Icon name="photo" />
				{copy.composer.attachMedia}
			</button>
			<button type="button" role="menuitem" onClick={onFiles}>
				<Icon name="file" />
				{copy.composer.attachFile}
				<small>{copy.composer.attachMax(limit)}</small>
			</button>
			{onScreenshot !== undefined && (
				<button type="button" role="menuitem" onClick={onScreenshot}>
					<Icon name="camera" />
					{copy.composer.attachScreenshot}
					<small>
						<kbd>{altKeyLabel("S")}</kbd>
					</small>
				</button>
			)}
			{onRecordScreen !== undefined && (
				<button type="button" role="menuitem" onClick={onRecordScreen}>
					<Icon name="screen-record" />
					{copy.composer.attachRecordScreen}
					<small>
						<kbd>{altKeyLabel("R")}</kbd>
					</small>
				</button>
			)}
		</PopupMenu>
	);
}
