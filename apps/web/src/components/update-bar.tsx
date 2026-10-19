import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { appUpdateReady, subscribeAppUpdate } from "../register-service-worker.ts";

/** "Đã có bản mới · Tải lại" once a newer build has taken over (register-service-worker.ts). */
export function UpdateBar() {
	"use no memo";
	const ready = useSyncExternalStore(subscribeAppUpdate, appUpdateReady, () => false);
	const { t } = useI18n();
	if (!ready) return null;
	return (
		<div className="update-bar" role="status">
			<span>{t.update.available}</span>
			<span className="sep" aria-hidden="true">
				·
			</span>
			<button type="button" onClick={() => window.location.reload()}>
				{t.update.reload}
			</button>
		</div>
	);
}
