// The user's own settings of a chat, shared by the chat list's row menu and
// the info column's quick actions (mockups/chat.html#list-menu,
// #info-panels): mute for a while ("Tắt thông báo": 1 giờ … Cho đến khi bật
// lại) and pinned chats. Both are server state (SetDialogMute,
// SetDialogPinned) that reaches every session through the dialog list.
import { Code, ConnectError } from "@connectrpc/connect";
import { MUTE_FOREVER } from "@app/core";
import type { RefObject } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock, sameDay, shortDate } from "../data/format.ts";
import type { MuteFor } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { PopupMenu } from "./popup-menu.tsx";

/** SetDialogPinned's refusal past the limit (failed_precondition, "pinned_dialogs_limit…"). */
export function pinLimitReached(err: unknown): boolean {
	const error = ConnectError.from(err);
	return error.code === Code.FailedPrecondition && error.rawMessage.startsWith("pinned_dialogs_limit");
}

/** When a mute ends: "10:42" today, "09:42 16/10" on another day. */
export function muteEnd(until: number, locale: string): string {
	const now = Math.floor(Date.now() / 1000);
	return sameDay(until, now) ? clock(until, locale) : `${clock(until, locale)} ${shortDate(until, locale)}`;
}

/** Mutes (or with 0 unmutes) a chat and returns the confirmation to show. */
export function useMute(chatId: number, title: string): (label: string, muteFor: MuteFor) => Promise<string> {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote } = useServices();
	const t = copy.listMenu;
	return async (label, muteFor) => {
		const until = await remote.setDialogMute(chatId, muteFor);
		if (until === 0) return t.unmuted(title);
		return until === MUTE_FOREVER ? t.mutedForever : t.mutedFor(label, muteEnd(until, locale));
	};
}

interface DurationsProps {
	boundary?: RefObject<HTMLElement | null> | undefined;
	className?: string | undefined;
	onPick: (label: string, muteFor: MuteFor) => void;
	onClose: () => void;
}

/** 1 giờ, 8 giờ, 1 ngày, 1 tuần, Cho đến khi bật lại. */
export function MuteDurations({ boundary, className, onPick, onClose }: DurationsProps) {
	const copy = useScreensCopy();
	const t = copy.listMenu;
	const durations: { label: string; muteFor: MuteFor }[] = [
		{ label: t.hour, muteFor: 3600 },
		{ label: t.hours8, muteFor: 8 * 3600 },
		{ label: t.day, muteFor: 86_400 },
		{ label: t.week, muteFor: 7 * 86_400 },
		{ label: t.forever, muteFor: "forever" },
	];
	return (
		<PopupMenu label={t.muteFor} boundary={boundary} className={className} onClose={onClose}>
			{durations.map((duration) => (
				<button key={duration.label} type="button" role="menuitem" onClick={() => onPick(duration.label, duration.muteFor)}>
					{duration.label}
				</button>
			))}
		</PopupMenu>
	);
}
