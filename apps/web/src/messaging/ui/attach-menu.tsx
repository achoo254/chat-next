// The composer's attach menu (mockups/media.html #attach): photos and
// videos, or any file up to the server's limit. Loaded when first opened.
import type { RefObject } from "react";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { PopupMenu } from "./popup-menu.tsx";

interface AttachMenuProps {
	boundary: RefObject<HTMLElement | null>;
	/** "tối đa 2 GB" as the composer words it. */
	limit: string;
	onMedia: () => void;
	onFiles: () => void;
	onClose: () => void;
}

export default function AttachMenu({ boundary, limit, onMedia, onFiles, onClose }: AttachMenuProps) {
	const copy = useCopy();
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
		</PopupMenu>
	);
}
