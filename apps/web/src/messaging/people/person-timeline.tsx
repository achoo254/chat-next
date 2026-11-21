// The merged timeline of a linked person (ADR 0025): the messages of their
// private chats in date order, each with the app it came through, day
// dividers and runs as in a chat (ui/message-list.tsx's pure helpers). Its
// rows are never trimmed (merged-timeline.ts), so unlike a chat's list there
// is no window to slide: scrolling to the top loads older pages, the first
// row on screen keeps its place when they arrive, and new rows are followed
// while the list is at its newest message. A chat that failed to load says
// so above the list, with a retry, while the others show. Reading follows
// merged-read.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLoader } from "../../components/delayed-loader.tsx";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dayLabel, sameDay } from "../data/format.ts";
import { useListStatus, useServices } from "../data/services.tsx";
import { appLabel } from "../ui/link-suggestions.tsx";
import type { LimitedActions } from "../ui/message-item.tsx";
import { joinsRun } from "../ui/message-runs.ts";
import { useSurfaceVisible } from "../ui/surface.ts";
import { DeliveryHub } from "./merged-delivery.tsx";
import { MergedMenu, MergedRow } from "./merged-row.tsx";
import { groupMerged, rowOfMessage, unreadDividerKey, type MergedGroup } from "./merged-rows.ts";
import type { MergedItem } from "./merged-timeline.ts";
import { useMergedRead } from "./merged-read.ts";
import type { LinkedPerson } from "./people-api.ts";
import { useMergedTimeline } from "./use-merged-timeline.ts";
import { useUnreadAtOpen } from "./use-unread-at-open.ts";

/** Within this distance of the top, older messages load. */
const EDGE_PX = 240;
/** Within this distance of the bottom, the list is at its newest message. */
const BOTTOM_PX = 48;

function itemDate(item: MergedItem): number {
	return item.kind === "message" ? item.message.date : item.pending.date;
}

/** Two rows draw as one run only within one chat: the app label of each stays readable. */
function sameRun(previous: MergedItem | undefined, next: MergedItem | undefined, selfId: number): boolean {
	return previous !== undefined && next !== undefined && previous.chatId === next.chatId && joinsRun(previous, next, selfId);
}

/** The first message row in the list and where it sits, to keep it in place when older rows arrive above it. */
function firstRow(element: HTMLElement): { key: string; top: number } | null {
	const node = element.querySelector<HTMLElement>("[data-key]");
	return node === null ? null : { key: node.dataset.key ?? "", top: node.offsetTop };
}

interface PersonTimelineProps {
	person: LinkedPerson;
	/** What a message offers here: reply and edit go through the screen that sends; showing a quoted message is added here. */
	actions: LimitedActions;
}

export function PersonTimeline({ person, actions }: PersonTimelineProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const [timeline, snapshot] = useMergedTimeline(person);
	const { items, status, hasOlder, loadingOlder, failures } = snapshot;
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const anchor = useRef<{ key: string; top: number } | null>(null);
	const [atBottom, setAtBottom] = useState(true);
	const [focused, setFocused] = useState<string | null>(null);
	const placed = useRef(false);
	const visible = useSurfaceVisible();
	const loader = useLoader(status === "loading" && items.length === 0, copy.common.loading);
	const t = copy.personScreen;

	const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
	const groups = useMemo(() => groupMerged(items), [items]);
	const groupsRef = useRef<readonly MergedGroup[]>(groups);
	useLayoutEffect(() => {
		groupsRef.current = groups;
	}, [groups]);
	const lastKey = groups[groups.length - 1]?.key ?? "";
	// What was unread in each chat when the screen opened: the divider sits there and stays when the messages are read.
	// The dialogs are known first: reading marks a chat read, which would erase what was unread.
	const dialogsKnown = useListStatus() !== "loading";
	const unreadFrom = useUnreadAtOpen(person.members, status === "ready" && dialogsKnown);
	const divider = unreadFrom === null ? "" : unreadDividerKey(groups, unreadFrom, store.selfId);
	const tabKey = focused !== null && byKey.has(focused) ? focused : lastKey;

	useMergedRead(timeline, items, visible && atBottom && status === "ready" && unreadFrom !== null);

	// Opened with unread messages: the divider goes at the top, as in a chat, and the reader reads down to the newest.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null || placed.current || divider === "") return;
		const mark = element.querySelector<HTMLElement>(".unread-div");
		if (mark === null) return;
		placed.current = true;
		stick.current = false;
		element.scrollTop = Math.max(0, mark.offsetTop - 8);
		anchor.current = firstRow(element);
		setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_PX);
	}, [divider]);

	// A quoted message: on this timeline it is scrolled to and outlined; older than what is loaded, it opens in its own chat.
	const jump = useCallback(
		(chatId: number, seq: number) => {
			const key = rowOfMessage(groupsRef.current, chatId, seq);
			const row = key === null ? null : scroller.current?.querySelector<HTMLElement>(`[data-key="${key}"]`);
			if (row === null || row === undefined) {
				store.openWindow(chatId, seq);
				navigate(paths.chat(chatId));
				return;
			}
			stick.current = false;
			const element = scroller.current;
			if (element !== null) element.scrollTop = Math.max(0, row.offsetTop - element.clientHeight / 3);
			row.classList.add("flash");
			window.setTimeout(() => row.classList.remove("flash"), 1600);
		},
		[store],
	);
	const limited = useMemo<LimitedActions>(() => ({ ...actions, jump }), [actions, jump]);

	// After every change of the rows: follow the newest while at it, else keep the first row where it was.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null) return;
		const saved = anchor.current;
		if (stick.current) {
			element.scrollTop = element.scrollHeight;
		} else if (saved !== null) {
			const node = element.querySelector<HTMLElement>(`[data-key="${saved.key}"]`);
			if (node !== null) element.scrollTop += node.offsetTop - saved.top;
		}
		anchor.current = firstRow(element);
		// Too few rows to scroll: nothing would ever reach the top, so load further back now.
		if (status === "ready" && hasOlder && !loadingOlder && element.clientHeight > 0 && element.scrollHeight <= element.clientHeight) {
			void timeline?.loadOlder();
		}
	}, [items, status, hasOlder, loadingOlder, timeline, loader]);

	// Bubbles grow after they first render (media, link previews): at the newest message, stay there.
	useEffect(() => {
		const element = scroller.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const resized = new ResizeObserver(() => {
			if (stick.current) element.scrollTop = element.scrollHeight;
		});
		for (const row of element.children) resized.observe(row);
		return () => resized.disconnect();
	}, [items, loader]);

	const onScroll = () => {
		const element = scroller.current;
		if (element === null) return;
		stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_PX;
		setAtBottom(stick.current);
		if (element.scrollTop < EDGE_PX && hasOlder && !loadingOlder) void timeline?.loadOlder();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		const current = (event.target as HTMLElement).closest<HTMLElement>("[data-key]");
		if (current === null || current !== event.target) return;
		const index = groups.findIndex((group) => group.key === current.dataset.key);
		const next = groups[index + (event.key === "ArrowUp" ? -1 : 1)];
		if (index < 0 || next === undefined) return;
		event.preventDefault();
		setFocused(next.key);
		scroller.current?.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus();
	};

	const failed = [...failures].map(([chatId, kind]) => {
		const app = appLabel(person.members.find((member) => member.chatId === chatId)?.app ?? "", copy);
		return (
			<div className="banner error" role="alert" key={chatId}>
				<Icon name="alert" small />
				<span className="grow">{kind === "permanent" ? t.refused(app) : t.loadFailed(app)}</span>
				{kind !== "permanent" && (
					<button type="button" className="btn btn-sm" onClick={() => void timeline?.refresh()}>
						{copy.common.retry}
					</button>
				)}
			</div>
		);
	});

	const rows: ReactNode[] = [];
	const now = new Date();
	let previousDate = 0;
	groups.forEach((group, index) => {
		const item = group.item;
		const date = itemDate(item);
		if (date !== 0 && (previousDate === 0 || !sameDay(previousDate, date))) {
			rows.push(
				<span className="day" key={`d${item.key}`}>
					{dayLabel(date, now, locale, copy)}
				</span>,
			);
		}
		previousDate = date || previousDate;
		if (group.key === divider) {
			rows.push(
				<div className="unread-div" role="separator" key={`u${group.key}`}>
					{copy.convo.unreadDivider}
				</div>,
			);
		}
		rows.push(
			<MergedRow
				key={group.key}
				group={group}
				tabbable={group.key === tabKey}
				runPrev={sameRun(groups[index - 1]?.item, item, store.selfId)}
				runNext={sameRun(item, groups[index + 1]?.item, store.selfId)}
				limited={limited}
			/>,
		);
	});

	const chatIds = person.members.filter((member) => member.chatId !== 0).map((member) => member.chatId);
	return (
		<DeliveryHub chatIds={chatIds}>
			{failed}
			<div className="messages-wrap">
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys pressed on a focused message bubble here to move between messages */}
				<div
					className="messages"
					ref={scroller}
					onScroll={onScroll}
					onKeyDown={onKeyDown}
					onFocus={(event) => {
						const key = (event.target as HTMLElement).dataset.key;
						if (key !== undefined) setFocused(key);
					}}
					role="log"
					aria-label={t.messages(person.name)}
					aria-busy={loader !== null}
					aria-live="polite"
					aria-relevant="additions"
				>
					{loader}
					{loadingOlder && (
						<span className="system" role="status">
							<span className="spin" aria-hidden="true" />
							<span className="sr-only">{t.loadingOlder}</span>
						</span>
					)}
					{status === "ready" && !hasOlder && items.length > 0 && <span className="system">{t.start}</span>}
					{status === "ready" && items.length === 0 && failures.size === 0 && <span className="system">{t.empty}</span>}
					{rows}
				</div>
				{!atBottom && (
					<div className="jump-stack">
						<button
							type="button"
							className="to-bottom"
							aria-label={copy.convo.toBottom(0)}
							onClick={() => {
								stick.current = true;
								setAtBottom(true);
								const element = scroller.current;
								if (element !== null) element.scrollTop = element.scrollHeight;
							}}
						>
							<Icon name="arrow-down" />
						</button>
					</div>
				)}
			</div>
			<MergedMenu items={byKey} limited={limited} />
		</DeliveryHub>
	);
}
