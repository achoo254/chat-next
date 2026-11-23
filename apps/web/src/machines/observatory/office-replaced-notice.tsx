// The one-line notice that the session's "Văn phòng" tab became "Quan sát",
// over the map of the first session view opened after the update. It is
// remembered on this device as soon as it shows, so later views open without
// it; closing hides it at once. Storage refused (private mode, quota): it
// may show again in a later view, the view itself never fails.
import { useEffect, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";

/** Set once the notice has been shown on this device. */
export const OFFICE_REPLACED_SEEN_KEY = "observe.officeReplacedSeen";

function seen(): boolean {
	try {
		return localStorage.getItem(OFFICE_REPLACED_SEEN_KEY) === "1";
	} catch {
		return false;
	}
}

function markSeen(): void {
	try {
		localStorage.setItem(OFFICE_REPLACED_SEEN_KEY, "1");
	} catch {
		// Storage refused: nothing to remember it by.
	}
}

export function OfficeReplacedNotice() {
	const t = useMachinesCopy().observe.replaced;
	const [shown, setShown] = useState(() => !seen());
	useEffect(() => {
		if (shown) markSeen();
	}, [shown]);
	if (!shown) return null;
	return (
		<p className="lmd-notice" role="status" data-id="observe-office-replaced">
			<span>{t.text}</span>
			<button type="button" className="icon-btn" aria-label={t.close} data-id="observe-office-replaced-close" onClick={() => setShown(false)}>
				<Icon name="x" small />
			</button>
		</p>
	);
}
