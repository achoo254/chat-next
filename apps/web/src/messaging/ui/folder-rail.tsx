// The account menu, then the built-in folders (R1): Tất cả, Cá nhân, Nhóm,
// Bot filtered on the client by chat kind, and Chưa đọc by read state, with
// AI Agent (chats with the AI on the user's machines, its badge counting the
// sessions that need the user) beside them; then Danh bạ, the app switcher
// and Cài đặt. Wide screens show the labelled rail, the same one on Settings and
// the admin pages so the frame does not change under the user; narrow screens
// the tab row inside the list (mockups/chat.html#app, #contacts, #narrow) and
// the compact top bar elsewhere (screens/shell.tsx). Badges count
// chats with unread messages, muted chats left out. ⌘/Ctrl+1…5 pick a folder.
// Each app chats are synced with (Chat Bridge) has a folder after Chưa đọc, with its
// logo, holding that app's chats; Telegram and Zalo are always there, empty or not,
// and the shortcuts keep their positions.
import type { SelfUser } from "../../api/adapters.ts";
import { AppLogo, hasAppLogo } from "../../components/app-logo.tsx";
import { EcosystemAppSwitcher } from "../../components/ecosystem-app-switcher.tsx";
import { Icon, type IconName } from "../../components/icon.tsx";
import { followInApp, Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { appName, countLabel, FOLDERS, type Folder } from "../data/format.ts";
import { useAppFolders, useFolderCounts } from "../data/services.tsx";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { AccountMenuSlot } from "./account-menu-slot.tsx";
import { AgentIcon } from "../../machines/cpu-icon.tsx";
import { useAgentNeeds } from "../../machines/agent-needs.ts";

const FOLDER_ICONS: Record<Folder, IconName> = { all: "message", private: "user", group: "users", bot: "robot", unread: "message-dot" };

interface FolderProps {
	folder: Folder;
	/** The app folder picked, or null when a built-in folder is. */
	app: string | null;
	onFolder: (folder: Folder) => void;
	onApp: (app: string) => void;
}

interface FolderRailProps {
	self: SelfUser;
	/** null: no folder is shown (the contacts list, Settings or an admin page is open). */
	folder: Folder | null;
	/** Settings is open: its link shows as current. */
	settings?: boolean;
	/** "My machines" is open: its link shows as current. */
	machines?: boolean;
	app: string | null;
	onFolder: (folder: Folder) => void;
	onApp: (app: string) => void;
}

export function FolderRail({ self, folder, settings = false, machines = false, app, onFolder, onApp }: FolderRailProps) {
	"use no memo";
	const copy = useCopy();
	const counts = useFolderCounts();
	const apps = useAppFolders();
	return (
		<nav className="folder-rail" aria-label={copy.folders.nav}>
			<AccountMenuSlot self={self} />
			{FOLDERS.map((item) => (
				<button
					key={item}
					type="button"
					className="folder"
					aria-current={item === folder && app === null ? "true" : undefined}
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
			{[...apps].map(([name, unread]) => (
				<button key={`app:${name}`} type="button" className="folder" aria-current={name === app && folder !== null ? "true" : undefined} onClick={() => onApp(name)}>
					{hasAppLogo(name) ? <AppLogo app={name} size={20} /> : <Icon name="message" />}
					{appName(name)}
					{unread > 0 && (
						<span className="badge" aria-label={copy.folders.unreadChats(unread)}>
							{countLabel(unread)}
						</span>
					)}
				</button>
			))}
			<Link to={paths.machines()} className="folder" current={machines}>
				<AgentIcon />
				{copy.folders.machines}
				<AgentBadge />
			</Link>
			<span className="spacer" />
			<Link to={paths.contacts()} className="folder" current={folder === null && !settings && !machines}>
				<ContactsGlyph />
				{copy.folders.contacts}
			</Link>
			<EcosystemAppSwitcher placement="right-end" className="folder-switcher" />
			<Link to={paths.settingsList} className="folder" current={settings}>
				<Icon name="settings" />
				{copy.folders.settings}
			</Link>
		</nav>
	);
}

/** The compact filter row that stands in for the rail on narrow screens; AI Agent opens its own screen. */
export function FolderTabs({ folder, app, onFolder, onApp }: FolderProps) {
	"use no memo";
	const copy = useCopy();
	const apps = useAppFolders();
	const agent = paths.machines();
	return (
		<div className="tabs folder-tabs" role="tablist" aria-label={copy.folders.filterTabs}>
			{FOLDERS.map((item) => (
				<button key={item} type="button" role="tab" aria-selected={item === folder && app === null} onClick={() => onFolder(item)}>
					{copy.folders[item]}
				</button>
			))}
			{[...apps.keys()].map((name) => (
				<button key={`app:${name}`} type="button" role="tab" aria-selected={name === app} onClick={() => onApp(name)}>
					{hasAppLogo(name) && <AppLogo app={name} size={16} />}
					{appName(name)}
				</button>
			))}
			<a href={agent} role="tab" aria-selected={false} className="folder-tab-link" onClick={(event) => followInApp(event, agent)}>
				{copy.folders.machines}
				<AgentBadge />
			</a>
		</div>
	);
}

/** AI sessions waiting for the user on any machine (agent-needs.ts). */
function AgentBadge() {
	"use no memo";
	const copy = useCopy();
	const needs = useAgentNeeds();
	return needs > 0 ? (
		<span className="badge" aria-label={copy.folders.agentNeeds(needs)}>
			{countLabel(needs)}
		</span>
	) : null;
}
