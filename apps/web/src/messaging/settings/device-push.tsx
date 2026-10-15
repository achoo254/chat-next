// "Thiết bị này" of the notifications tab (mockups/settings.html#notifications):
// Web Push for this browser or installed app, with its states (needs the
// home screen app on iPhone, blocked by the browser, not supported). Hidden
// when the server has Web Push off.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { pushOnDevice, subscribePushOnDevice } from "../push/push-device.ts";
import type { PushStatus } from "../push/web-push.ts";
import { Switch } from "../ui/parts.tsx";

/** Whether this device gets Web Push (the notifications tab's closing note follows it). */
export function usePushOnDevice(selfId: number): boolean {
	return useSyncExternalStore(subscribePushOnDevice, () => pushOnDevice(selfId));
}

interface DevicePushProps {
	/** The browser's permission changed (asked when turning pushes on). */
	onPermission: (permission: NotificationPermission) => void;
}

export function DevicePush({ onPermission }: DevicePushProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { webPush, toasts } = useServices();
	// null: not known yet, or nothing to show (Web Push off, or the server could not be asked).
	const [status, setStatus] = useState<PushStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const t = copy.notifications;

	useEffect(() => {
		let live = true;
		webPush.status().then(
			(found) => {
				if (live) setStatus(found);
			},
			() => {
				if (live) setStatus(null);
			},
		);
		return () => {
			live = false;
		};
	}, [webPush]);

	if (status === null || status.kind === "off") return null;

	const toggle = (on: boolean) => {
		setBusy(true);
		(on ? webPush.enable(locale) : webPush.disable())
			.then(
				(next) => {
					setStatus(next);
					if (next.kind !== "ready") return;
					onPermission(next.permission);
					if (next.enabled) toasts.show(t.pushEnabled);
					else if (!on) toasts.show(t.pushDisabled);
				},
				() => toasts.show(t.pushFailed),
			)
			.finally(() => setBusy(false));
	};

	let row;
	switch (status.kind) {
		case "needs-install":
			row = (
				<div className="row pad-x">
					<span className="device">
						<Icon name="mobile" />
					</span>
					<span className="grow">
						{t.push}
						<small>{t.pushNeedsInstall}</small>
					</span>
					<Link to={paths.settings("app")} className="btn btn-sm">
						{t.howToInstall}
					</Link>
				</div>
			);
			break;
		case "unsupported":
			row = (
				<div className="row pad-x">
					<span className="device">
						<Icon name="bell-off" />
					</span>
					<span className="grow">
						{t.push}
						<small>{t.pushUnsupported}</small>
					</span>
				</div>
			);
			break;
		case "ready": {
			const blocked = status.permission === "denied";
			row = (
				<div className="row pad-x">
					<span className="device">
						<Icon name={blocked ? "bell-off" : "bell"} />
					</span>
					<span className="grow">
						{t.push}
						<small>{blocked ? t.pushBlocked : t.pushHint}</small>
					</span>
					<Switch checked={status.enabled} disabled={busy || blocked} label={t.push} onChange={toggle} />
				</div>
			);
			break;
		}
	}
	return (
		<div className="card" data-id="notifications-device">
			<h2 className="card-title">{t.device}</h2>
			{row}
		</div>
	);
}
