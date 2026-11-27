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
	/** The machine tunelo-capture takes the screenshot on ("this computer"); none: the browser's own. */
	screenshotOn?: string | undefined;
	/** Several of the account's computers can take it: one item each, and the browser's, remembered once picked. */
	screenshotChoices?: readonly { readonly ref: string; readonly name: string }[] | undefined;
	onPickScreenshot?: ((ref: string | "web") => void) | undefined;
	/** Shown where the browser can also record it. */
	onRecordScreen?: (() => void) | undefined;
	onClose: () => void;
}

export default function AttachMenu({ boundary, limit, onMedia, onFiles, onScreenshot, screenshotOn, screenshotChoices, onPickScreenshot, onRecordScreen, onClose }: AttachMenuProps) {
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
				<button type="button" role="menuitem" onClick={onScreenshot} title={screenshotOn === undefined ? undefined : copy.composer.attachScreenshotOn(screenshotOn)}>
					<Icon name="camera" />
					{copy.composer.attachScreenshot}
					<small>
						<kbd>{altKeyLabel("S")}</kbd>
					</small>
				</button>
			)}
			{screenshotChoices !== undefined && onPickScreenshot !== undefined && (
				<>
					{screenshotChoices.map((m) => (
						<button type="button" role="menuitem" key={m.ref} onClick={() => onPickScreenshot(m.ref)}>
							<Icon name="camera" />
							{copy.composer.attachScreenshotOn(m.name)}
						</button>
					))}
					<button type="button" role="menuitem" onClick={() => onPickScreenshot("web")}>
						<Icon name="camera" />
						{copy.composer.attachScreenshotBrowser}
					</button>
				</>
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
