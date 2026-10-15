// Dialogs of the Developer Console shared by its tabs: "Đăng nhập lại để
// tiếp tục" before an action that needs a recent sign-in (ADR 0006), and the
// confirmation such an action opens on coming back (`?after=`), which acts
// only from its own button.
import { useEffect, useEffectEvent, type ReactNode } from "react";
import { signInUrl } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { paths, type ConsoleTab } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import type { OwnBot } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";

/** What to ask again on coming back from the reauth sign-in (?after=…). */
export type After = "token" | "delete" | "webhook";

/** Where the reauth sign-in sends the browser, coming back to `tab` to carry on with `after`. */
export function reauthUrl(locale: string, botId: number, tab: ConsoleTab, after: After): string {
	return signInUrl(locale, { reauth: true, returnTo: `${paths.consoleBot(botId, tab)}?after=${after}` });
}

/** `confirmNow`: back from the reauth sign-in, open the tab's confirmation (delete, issue or webhook), then call `onConfirmShown`. */
export interface TabProps {
	bot: OwnBot;
	confirmNow: boolean;
	onConfirmShown: () => void;
}

/** Marks a confirmation opened from ?after= as shown, once the tab has it on screen. */
export function useConfirmShown(confirmNow: boolean, onConfirmShown: () => void): void {
	const report = useEffectEvent(onConfirmShown);
	useEffect(() => {
		if (confirmNow) report();
	}, [confirmNow]);
}

/** "Đăng nhập lại để tiếp tục" (mockups/console.html#token): a link to the reauth sign-in. */
export function ReauthDialog({ body, warning, href, onClose }: { body: string; warning: string; href: string; onClose: () => void }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const id = useDomId("reauth");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.reauth.title} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="dlg-lede">{body}</p>
				<p className="note">{t.reauth.away}</p>
				{warning !== "" && (
					<div className="banner warn">
						<Icon name="alert" small />
						<span className="grow">{warning}</span>
					</div>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<a className="btn btn-primary" href={href}>
					{t.reauth.signIn}
					<Icon name="external" small />
				</a>
			</div>
		</Modal>
	);
}

export function ConfirmDialog({
	title,
	body,
	action,
	busyLabel,
	busy,
	danger,
	onConfirm,
	onClose,
}: {
	title: string;
	body: ReactNode;
	action: string;
	busyLabel: string;
	busy: boolean;
	danger: boolean;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const copy = useCopy();
	const id = useDomId("confirm");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={title} onClose={onClose} />
			<div className="dlg-body stack">{body}</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} disabled={busy} aria-busy={busy} onClick={onConfirm}>
					{busy ? busyLabel : action}
				</button>
			</div>
		</Modal>
	);
}
