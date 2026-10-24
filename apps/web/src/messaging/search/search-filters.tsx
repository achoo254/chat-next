// Filter chips of the search (mockups/search.html#filters): "Người gửi",
// "Loại" and "Ngày" open a popover; a filter in use shows as a chip with a
// remove button. The same sender picker serves the in-chat search, where it
// lists the chat's members.
import { fold } from "@achoo254/chat-core";
import { useId, useMemo, useState } from "react";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { useDialogOrder, useServices, useUser } from "../data/services.tsx";
import { useMembers } from "../ui/members.ts";
import { ChatAvatar } from "../ui/parts.tsx";
import { DateRange } from "./date-range.tsx";
import { rangeLabel, TYPE_FILTERS, type TypeFilter, type UiFilters } from "./filters.ts";
import { Popover } from "./popover.tsx";

const TYPE_ICONS: Record<TypeFilter, IconName> = { photo: "photo", document: "file", link: "link", voice: "mic" };

interface SenderOption {
	readonly id: number;
	readonly name: string;
	readonly bot: boolean;
}

/** The sender's name as the filter chip shows it ("Tôi" for the user). */
export function useSenderName(userId: number): string {
	const copy = useScreensCopy();
	const { store } = useServices();
	const user = useUser(userId === store.selfId ? 0 : userId);
	if (userId === 0) return "";
	return userId === store.selfId ? copy.search.me : (user?.name ?? "");
}

const MAX_SENDERS = 30;

/** Picks a sender: the chat's members (in-chat search) or the user's contacts and private chats. */
export function SenderPicker({ id, chatId, onPick, onClose }: { id: string; chatId: number; onPick: (userId: number) => void; onClose: () => void }) {
	const copy = useScreensCopy();
	const { store, remote } = useServices();
	const [query, setQuery] = useState("");
	const members = useMembers(chatId, query.trim(), chatId !== 0);
	const contacts = useContacts(remote);
	const order = useDialogOrder();
	const options = useMemo<SenderOption[]>(() => {
		const words = fold(query).split(" ").filter((word) => word !== "");
		const matches = (name: string) => {
			const folded = fold(name);
			return words.every((word) => folded.includes(word));
		};
		const byId = new Map<number, SenderOption>();
		const add = (option: SenderOption) => {
			if (!byId.has(option.id) && byId.size < MAX_SENDERS) byId.set(option.id, option);
		};
		const self = { id: store.selfId, name: copy.search.me, bot: false };
		if (chatId !== 0) {
			for (const { person } of members.members) {
				add(person.id === store.selfId ? self : { id: person.id, name: person.name, bot: person.isBot });
			}
			return [...byId.values()];
		}
		if (matches(copy.search.me)) add(self);
		for (const { person } of contacts.entries) {
			if (matches(person.name)) add({ id: person.id, name: person.name, bot: person.isBot });
		}
		for (const dialogId of order) {
			const peer = store.dialog(dialogId)?.peer;
			if (peer != null && !peer.isSelf && matches(peer.name)) add({ id: peer.id, name: peer.name, bot: peer.isBot });
		}
		return [...byId.values()];
	}, [query, chatId, members.members, contacts.entries, order, store, copy]);

	return (
		<Popover id={id} label={copy.search.sender} className="sx-senders" onClose={onClose}>
			<label className="search-field">
				<Icon name="search" small />
				<span className="sr-only">{copy.search.senderSearch}</span>
				<input type="search" placeholder={copy.search.senderSearch} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
			</label>
			<ul className="sx-sender-list" aria-label={copy.search.sender}>
				{options.map((option) => (
					<li key={option.id}>
						<button type="button" onClick={() => onPick(option.id)}>
							<ChatAvatar id={option.id} name={option.name} size="xs" bot={option.bot} />
							<span>{option.name}</span>
						</button>
					</li>
				))}
			</ul>
			{options.length === 0 && (chatId === 0 || members.status !== "loading") && <p className="muted">{copy.search.noSender}</p>}
		</Popover>
	);
}

type Open = "sender" | "type" | "date" | null;

interface FilterBarProps {
	filters: UiFilters;
	onChange: (filters: UiFilters) => void;
	/** Local midnight today (ms). */
	today: number;
}

/** The chips of the global search. */
export function FilterBar({ filters, onChange, today }: FilterBarProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const [open, setOpen] = useState<Open>(null);
	const base = useId();
	const ids = { sender: `${base}-sender`, type: `${base}-type`, date: `${base}-date` };
	const sender = useSenderName(filters.fromId);
	const toggle = (which: Exclude<Open, null>) => setOpen((current) => (current === which ? null : which));
	const close = () => setOpen(null);
	const typeName = filters.type === null ? "" : copy.search.types[filters.type];

	return (
		<div className="sx-filters">
			<div className="chips sx-chips" role="group" aria-label={copy.search.filters}>
				{filters.fromId !== 0 ? (
					<span className="chip on">
						<ChatAvatar id={filters.fromId} name={sender} size="xs" />
						{sender}
						<button type="button" className="chip-x" aria-label={copy.search.removeSender(sender)} onClick={() => onChange({ ...filters, fromId: 0 })}>
							<Icon name="x" small />
						</button>
					</span>
				) : (
					<button type="button" className="chip" aria-haspopup="dialog" aria-expanded={open === "sender"} aria-controls={ids.sender} onClick={() => toggle("sender")}>
						<Icon name="user" small />
						{copy.search.sender}
						<Icon name="chevron-down" small />
					</button>
				)}
				{filters.type !== null ? (
					<span className="chip on">
						<Icon name={TYPE_ICONS[filters.type]} small />
						{typeName}
						<button type="button" className="chip-x" aria-label={copy.search.removeType(typeName)} onClick={() => onChange({ ...filters, type: null })}>
							<Icon name="x" small />
						</button>
					</span>
				) : (
					<button type="button" className="chip" aria-haspopup="dialog" aria-expanded={open === "type"} aria-controls={ids.type} onClick={() => toggle("type")}>
						<Icon name="file" small />
						{copy.search.type}
						<Icon name="chevron-down" small />
					</button>
				)}
				{filters.fromDay !== 0 ? (
					<span className="chip on">
						<button type="button" className="chip-label" aria-haspopup="dialog" aria-expanded={open === "date"} aria-controls={ids.date} onClick={() => toggle("date")}>
							<Icon name="clock" small />
							{rangeLabel(filters.fromDay, filters.toDay, locale)}
						</button>
						<button type="button" className="chip-x" aria-label={copy.search.removeDate} onClick={() => onChange({ ...filters, fromDay: 0, toDay: 0 })}>
							<Icon name="x" small />
						</button>
					</span>
				) : (
					<button type="button" className="chip" aria-haspopup="dialog" aria-expanded={open === "date"} aria-controls={ids.date} onClick={() => toggle("date")}>
						<Icon name="clock" small />
						{copy.search.date}
						<Icon name="chevron-down" small />
					</button>
				)}
			</div>
			{open === "sender" && (
				<SenderPicker
					id={ids.sender}
					chatId={0}
					onClose={close}
					onPick={(fromId) => {
						close();
						onChange({ ...filters, fromId });
					}}
				/>
			)}
			{open === "type" && (
				<Popover id={ids.type} label={copy.search.type} className="sx-types" onClose={close}>
					<div className="chips" role="group" aria-label={copy.search.type}>
						{TYPE_FILTERS.map((type) => (
							<button
								key={type}
								type="button"
								className="chip"
								aria-pressed={filters.type === type}
								onClick={() => {
									close();
									onChange({ ...filters, type });
								}}
							>
								<Icon name={TYPE_ICONS[type]} small />
								{copy.search.types[type]}
							</button>
						))}
					</div>
				</Popover>
			)}
			{open === "date" && (
				<DateRange
					id={ids.date}
					fromDay={filters.fromDay}
					toDay={filters.toDay}
					today={today}
					onClose={close}
					onApply={(fromDay, toDay) => {
						close();
						onChange({ ...filters, fromDay, toDay });
					}}
				/>
			)}
		</div>
	);
}
