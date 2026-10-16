// Pieces shared by the webhook screens: error codes, the status of a hook,
// times, the hook avatar, paged lists and the one-time URL dialog.
import { useEffect, useEffectEvent, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { Icon, type IconName } from "../../components/icon.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { MessagingCopy } from "../copy/vi.ts";
import { clock, integrationTone, sameDay, shortDate } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { CopyButton, DialogHead, Modal, Switch, useDomId } from "../ui/parts.tsx";
import type { Hook, HookFormat } from "./api.ts";
import type { HooksCopy } from "./copy-vi.ts";
import { sampleCommand, sampleResponse } from "./samples.ts";
import { useHooksCopy } from "./use-hooks-copy.ts";

export type HookErrorCode = "hooks_limit" | "creator_not_admin" | "no_previous_secret" | "not_found" | "permission_denied" | "invalid" | "other";

/** The failure of a management call: the server's precondition tag ("hooks_limit: …") or its status code. */
export function hookErrorCode(err: unknown): HookErrorCode {
	const error = ConnectError.from(err);
	if (error.code === Code.FailedPrecondition) {
		const tag = error.rawMessage.split(":", 1)[0]?.trim();
		if (tag === "hooks_limit" || tag === "creator_not_admin" || tag === "no_previous_secret") return tag;
		return "other";
	}
	if (error.code === Code.NotFound) return "not_found";
	if (error.code === Code.PermissionDenied) return "permission_denied";
	if (error.code === Code.InvalidArgument) return "invalid";
	return "other";
}

const FORMAT_ICONS: Record<HookFormat, IconName> = {
	native: "send",
	slack: "webhook",
	alertmanager: "alert",
	grafana: "alert-triangle",
	gitlab: "code",
};

/** The hook's avatar: an icon for its format, in the colour its messages use in the chat. */
export function HookAvatar({ hook, size = "sm" }: { hook: Pick<Hook, "name" | "format">; size?: "sm" | "md" }) {
	return (
		<span className={`avatar ${size === "sm" ? "sm " : ""}av-${integrationTone(hook.name)}`} aria-hidden="true">
			<Icon name={FORMAT_ICONS[hook.format]} small={size === "sm"} />
		</span>
	);
}

/** "/slack" and so on; Native JSON has no suffix. */
export function formatLabel(format: HookFormat, t: HooksCopy): string {
	const name = t.formats[format].name;
	return format === "native" ? name : `${name} · /${format}`;
}

export type StateTone = "ok" | "warn" | "err" | "off";

export interface StateView {
	readonly label: string;
	readonly tone: StateTone;
	/** Second line: why it is off, the old URL's grace, or "sends silently". */
	readonly sub: string;
}

/** Days and a clock: "6 ngày 23:47:58". */
export function countdown(seconds: number, t: HooksCopy): string {
	const left = Math.max(0, Math.floor(seconds));
	const pad = (n: number) => String(n).padStart(2, "0");
	const days = Math.floor(left / 86_400);
	return t.time.countdown(days, `${pad(Math.floor(left / 3600) % 24)}:${pad(Math.floor(left / 60) % 60)}:${pad(left % 60)}`);
}

/** Whole days or hours left, for the list ("URL cũ hết hạn sau 6 ngày"). */
function roughly(seconds: number, t: HooksCopy): string {
	return seconds >= 86_400 ? t.time.days(Math.floor(seconds / 86_400)) : t.time.hours(Math.max(1, Math.ceil(seconds / 3600)));
}

export function stateView(hook: Hook, nowSeconds: number, t: HooksCopy, channel: boolean): StateView {
	if (hook.state === "auto_disabled") {
		return {
			label: t.state.auto_disabled,
			tone: "err",
			sub: hook.disabledReason === "creator_left" ? t.stateSub.creatorLeft(channel) : t.stateSub.creatorNotAdmin,
		};
	}
	if (hook.state === "disabled") {
		return { label: t.state.disabled, tone: "off", sub: hook.disabledReason === "by_moderator" ? t.stateSub.byModerator : t.stateSub.byAdmin };
	}
	const grace = hook.previousSecretExpiresAt - nowSeconds;
	if (grace > 0) return { label: t.state.rotating, tone: "warn", sub: t.stateSub.oldUrl(roughly(grace, t)) };
	return { label: t.state.active, tone: "ok", sub: hook.silent ? t.stateSub.silent : "" };
}

/** 09:42 today, "Hôm qua 16:12", otherwise "03/10 09:42". */
export function whenText(unixSeconds: number, nowSeconds: number, locale: string, copy: MessagingCopy): string {
	const time = clock(unixSeconds, locale);
	if (sameDay(unixSeconds, nowSeconds)) return time;
	if (sameDay(unixSeconds, nowSeconds - 86_400)) return `${copy.list.yesterday} ${time}`;
	return `${shortDate(unixSeconds, locale)} ${time}`;
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** The current time in seconds, ticking every `everyMs` while `live`. */
export function useNow(live: boolean, everyMs = 1000): number {
	const [now, setNow] = useState(nowSeconds);
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => setNow(nowSeconds()), everyMs);
		return () => clearInterval(timer);
	}, [live, everyMs]);
	return now;
}

export interface Paged<T> {
	readonly items: readonly T[];
	readonly status: "loading" | "ready" | "error";
	/** A full page came back: there may be more. */
	readonly more: boolean;
	readonly loadMore: () => void;
	readonly reload: () => void;
}

/**
 * A newest-first list read a page at a time with a `beforeId` cursor (dead
 * letters, audit). A new `key` starts over; `idOf` gives an item's cursor.
 */
export function usePaged<T>(key: string, pageSize: number, load: (beforeId: number) => Promise<readonly T[]>, idOf: (item: T) => number): Paged<T> {
	const { toasts } = useServices();
	const copy = useCopy();
	const [attempt, setAttempt] = useState(0);
	const token = `${key}#${attempt}`;
	const [state, setState] = useState<PageState<T>>({ token, items: [], status: "loading", more: false });
	// Until the first page of a new key arrives, the old key's items are not shown.
	const current: PageState<T> = state.token === token ? state : { token, items: [], status: "loading", more: false };
	const loadFirst = useEffectEvent(() => load(0));

	useEffect(() => {
		let active = true;
		loadFirst().then(
			(page) => {
				if (active) setState({ token, items: page, status: "ready", more: page.length >= pageSize });
			},
			() => {
				if (active) setState({ token, items: [], status: "error", more: false });
			},
		);
		return () => {
			active = false;
		};
	}, [token, pageSize]);

	const last = current.items[current.items.length - 1];
	return {
		items: current.items,
		status: current.status,
		more: current.more,
		loadMore: () => {
			if (last === undefined) return;
			load(idOf(last)).then(
				(page) =>
					setState((latest) =>
						latest.token === token ? { ...latest, items: [...latest.items, ...page], more: page.length >= pageSize } : latest,
					),
				() => toasts.show(copy.common.failed),
			);
		},
		reload: () => setAttempt((n) => n + 1),
	};
}

interface PageState<T> {
	readonly token: string;
	readonly items: readonly T[];
	readonly status: Paged<T>["status"];
	readonly more: boolean;
}

interface OneTimeUrlProps {
	/** Dialog title: "Đã tạo webhook …" or "URL mới của …". */
	title: string;
	url: string;
	format: HookFormat;
	hookName: string;
	chatTitle: string;
	onDone: () => void;
}

/**
 * The full URL, shown this once (the server keeps only a hash): copy
 * button, a curl command for the format and its expected answer. "Xong"
 * unlocks after "Tôi đã lưu URL"; until then Esc and the backdrop do not
 * close it. The URL lives in this dialog's props only and goes with it.
 */
export function OneTimeUrlDialog({ title, url, format, hookName, chatTitle, onDone }: OneTimeUrlProps) {
	const t = useHooksCopy();
	const { toasts } = useServices();
	const [saved, setSaved] = useState(false);
	const id = useDomId("once");
	const command = sampleCommand(format, url, t.oneTime.greeting(hookName));
	const close = () => {
		if (!saved) {
			toasts.show(t.oneTime.savedFirst);
			return;
		}
		toasts.show(t.oneTime.hidden);
		onDone();
	};
	return (
		<Modal labelledBy={id} onClose={close} className="wide">
			<DialogHead id={id} title={title} />
			<div className="dlg-body stack">
				<div className="banner warn">
					<Icon name="alert" small />
					<span className="grow">{t.oneTime.warn(chatTitle)}</span>
				</div>
				<div className="field">
					<span className="label" id={`${id}-url`}>
						{t.oneTime.urlLabel(t.formats[format].name)}
					</span>
					<div className="secret" role="group" aria-labelledby={`${id}-url`}>
						<code className="secret-url">
							<MiddleTruncate text={url} tail={12} />
						</code>
						<CopyButton text={url} label={t.oneTime.copyUrl} copiedLabel={t.oneTime.urlCopied} small />
					</div>
				</div>
				<div className="field">
					<div className="snippet-head">
						<span id={`${id}-cmd`}>{t.oneTime.tryNow}</span>
						<CopyButton text={command} label={t.oneTime.copyCommand} copiedLabel={t.oneTime.commandCopied} small />
					</div>
					<pre className="snippet" aria-labelledby={`${id}-cmd`}>
						{command}
					</pre>
					<span className="hint">{t.oneTime.response(sampleResponse(format))}</span>
				</div>
			</div>
			<div className="dlg-foot">
				<div className="saved-row">
					<strong aria-hidden="true">{t.oneTime.saved}</strong>
					<Switch checked={saved} label={t.oneTime.saved} onChange={setSaved} />
				</div>
				<button type="button" className="btn btn-primary" disabled={!saved} onClick={close}>
					{t.oneTime.done}
				</button>
			</div>
		</Modal>
	);
}
