// Built-in folders (R1): Tất cả, Cá nhân, Nhóm, Bot, filtered on the client
// by chat kind. Wide screens show the labelled rail; narrow screens the tab
// row inside the list (mockups/chat.html#app). Custom folders come after R4.
import type { SelfUser } from "../../api/adapters.ts";
import { Icon, type IconName } from "../../components/icon.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { FOLDERS, type Folder } from "../data/format.ts";
import { useFolderCounts, useServices } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";

const FOLDER_ICONS: Record<Folder, IconName> = { all: "message", private: "user", group: "users", bot: "robot" };

interface FolderProps {
	folder: Folder;
	onFolder: (folder: Folder) => void;
}

export function FolderRail({ self, folder, onFolder }: FolderProps & { self: SelfUser }) {
	const copy = useCopy();
	const { toasts } = useServices();
	const counts = useFolderCounts();
	return (
		<nav className="folder-rail" aria-label={copy.folders.nav}>
			<span className="folder me" title={copy.folders.account}>
				<ChatAvatar id={self.id} name={self.name} size="sm" />
				<span className="sr-only">{copy.folders.account}</span>
			</span>
			{FOLDERS.map((item) => (
				<button
					key={item}
					type="button"
					className="folder"
					aria-current={item === folder ? "true" : undefined}
					onClick={() => onFolder(item)}
				>
					<Icon name={FOLDER_ICONS[item]} />
					{copy.folders[item]}
					{counts[item] > 0 && (
						<span className="badge" aria-label={copy.folders.unreadChats(counts[item])}>
							{counts[item]}
						</span>
					)}
				</button>
			))}
			<button
				type="button"
				className="folder"
				aria-disabled="true"
				aria-describedby="folder-edit-later"
				onClick={() => toasts.show(copy.folders.editHint)}
			>
				<Icon name="edit" />
				{copy.folders.edit}
				<span className="soon" id="folder-edit-later">
					{copy.folders.editLater}
				</span>
			</button>
			<span className="spacer" />
			<Link to={paths.settings("profile")} className="folder">
				<Icon name="settings" />
				{copy.folders.settings}
			</Link>
		</nav>
	);
}

/** The compact filter row that stands in for the rail on narrow screens. */
export function FolderTabs({ folder, onFolder }: FolderProps) {
	const copy = useCopy();
	return (
		<div className="tabs folder-tabs" role="tablist" aria-label={copy.folders.filterTabs}>
			{FOLDERS.map((item) => (
				<button key={item} type="button" role="tab" aria-selected={item === folder} onClick={() => onFolder(item)}>
					{copy.folders[item]}
				</button>
			))}
		</div>
	);
}
