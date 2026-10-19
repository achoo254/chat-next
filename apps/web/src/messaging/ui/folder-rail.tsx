// Built-in folders (R1): Tất cả, Cá nhân, Nhóm, Bot filtered on the client by
// chat kind, and Chưa đọc by read state; then Danh bạ and Cài đặt. Wide
// screens show the labelled rail; narrow screens the tab row inside the list
// (mockups/chat.html#app, #contacts, #narrow). Badges count chats with
// unread messages, muted chats left out. ⌘/Ctrl+1…5 pick a folder.
import type { SelfUser } from "../../api/adapters.ts";
import { Icon, type IconName } from "../../components/icon.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { countLabel, FOLDERS, type Folder } from "../data/format.ts";
import { useFolderCounts } from "../data/services.tsx";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { ChatAvatar } from "./parts.tsx";

const FOLDER_ICONS: Record<Folder, IconName> = { all: "message", private: "user", group: "users", bot: "robot", unread: "message-dot" };

interface FolderProps {
	folder: Folder;
	onFolder: (folder: Folder) => void;
}

/** `folder` null: the contacts list is open instead of a folder. */
export function FolderRail({ self, folder, onFolder }: { self: SelfUser; folder: Folder | null; onFolder: (folder: Folder) => void }) {
	const copy = useCopy();
	const counts = useFolderCounts();
	return (
		<nav className="folder-rail" aria-label={copy.folders.nav}>
			<span className="folder me" title={copy.folders.account}>
				<ChatAvatar id={self.id} name={self.name} photoOf={self.id} photoId={self.photoId} size="sm" />
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
					{item !== "unread" && counts[item] > 0 && (
						<span className="badge" aria-label={copy.folders.unreadChats(counts[item])}>
							{countLabel(counts[item])}
						</span>
					)}
				</button>
			))}
			<span className="spacer" />
			<Link to={paths.contacts()} className="folder" current={folder === null}>
				<ContactsGlyph />
				{copy.folders.contacts}
			</Link>
			<Link to={paths.settingsList} className="folder">
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
