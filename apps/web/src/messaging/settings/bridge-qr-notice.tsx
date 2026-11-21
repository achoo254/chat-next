// The notice shown before a QR login of an app with no official API for
// personal accounts (Zalo): what the unofficial connection risks and what Chat
// does with the account. Nothing reaches the server until the user ticks the
// box and continues.
import { useId, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";

export function BridgeQrNotice({ appName, onAccept, onCancel }: { appName: string; onAccept: () => void; onCancel: () => void }) {
	const t = useBridgeCopy();
	const [accepted, setAccepted] = useState(false);
	const titleId = useId();
	return (
		<section className="card pad br-qr-notice" data-id="bridge-qr-notice" aria-labelledby={titleId}>
			<h2 className="br-qr-heading" id={titleId}>
				<Icon name="alert" small />
				{t.qr.notice.title(appName)}
			</h2>
			<ul className="br-qr-points">
				{t.qr.notice.points(appName).map((point) => (
					<li key={point}>{point}</li>
				))}
			</ul>
			<label className="opt check" data-id="bridge-qr-notice-accept">
				<input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
				<span>{t.qr.notice.accept}</span>
			</label>
			<div className="row">
				<button type="button" className="btn btn-primary" data-id="bridge-qr-notice-continue" disabled={!accepted} onClick={onAccept}>
					{t.qr.notice.continue}
				</button>
				<button type="button" className="btn" data-id="bridge-qr-notice-cancel" onClick={onCancel}>
					{t.qr.cancel}
				</button>
			</div>
		</section>
	);
}
