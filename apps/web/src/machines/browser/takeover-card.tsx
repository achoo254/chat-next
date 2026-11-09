// The machine's browser needs the user (tunelo 2.0.12+), shown above the
// composer and outside the transcript:
// - a takeover the AI asked for: why, the page, "Mở trình duyệt" (the live
//   view) and "Trả lại cho <AI>" without doing anything;
// - a page that asked for a passkey nobody at the machine can give: what to
//   do, with "Mở điều khiển từ xa".
// The live view itself (takeover-view.tsx) loads only when opened.
import { lazy, Suspense, useState } from "react";
import type { BrowserTakeover, PasskeyNotice } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useDomId } from "../../messaging/ui/parts.tsx";
import { Origin } from "../cards/secret-request.tsx";
import type { MachineLink } from "../link/machine-link.ts";
import { BrowserIcon } from "./browser-icons.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

const TakeoverView = lazy(() => import("./takeover-view.tsx"));

/** The site of a page address, or the address itself when it has none. */
export function siteOf(url: string): string {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? url : origin;
	} catch {
		return url;
	}
}

interface TakeoverCardProps {
	takeover: BrowserTakeover;
	ai: string;
	onOpen: () => void;
	onGiveBack: () => Promise<void>;
}

export function TakeoverCard({ takeover, ai, onOpen, onGiveBack }: TakeoverCardProps) {
	const t = useMachinesCopy();
	const b = t.browser;
	const id = useDomId("takeover");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const expires = new Date(Number(takeover.expiresAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return (
		<section className="mx-action mx-takeover" aria-labelledby={`${id}-title`} data-id="takeover-card">
			<h4 id={`${id}-title`}>
				<Icon name="globe" />
				<span>{b.takeoverTitle}</span>
			</h4>
			<p>{takeover.reason}</p>
			{takeover.url !== "" && takeover.url !== "about:blank" && (
				<p className="mx-takeover-site">
					<Origin origin={siteOf(takeover.url)} />
				</p>
			)}
			<p className="note">{b.waits(ai)}</p>
			<div className="acts">
				<button type="button" className="btn btn-primary btn-sm" onClick={onOpen} data-id="takeover-card-open">
					<BrowserIcon name="pointer" small />
					{b.open}
				</button>
				<button
					type="button"
					className="btn btn-sm"
					disabled={busy}
					data-id="takeover-card-give-back"
					onClick={() => {
						setBusy(true);
						setError("");
						onGiveBack().then(
							() => setBusy(false),
							(err: unknown) => {
								setBusy(false);
								setError(errorText(t, err, ai));
							},
						);
					}}
				>
					{b.giveBack(ai)}
				</button>
				<span className="muted mx-secret-expires">{b.expires(expires)}</span>
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

export function PasskeyCard({ notice, ai, onOpen, onDismiss }: { notice: PasskeyNotice; ai: string; onOpen: () => void; onDismiss: () => void }) {
	const t = useMachinesCopy();
	const b = t.browser;
	const id = useDomId("passkey");
	return (
		<section className="mx-action mx-takeover" aria-labelledby={`${id}-title`} data-id="passkey-card">
			<h4 id={`${id}-title`}>
				<Icon name="key" />
				<span>{b.passkeyTitle}</span>
			</h4>
			<p>{b.passkeyBody(siteOf(notice.origin), ai)}</p>
			<div className="acts">
				<button type="button" className="btn btn-primary btn-sm" onClick={onOpen} data-id="passkey-card-open">
					{b.passkeyOpen}
				</button>
				<button type="button" className="btn btn-sm" onClick={onDismiss} data-id="passkey-card-dismiss">
					{b.dismiss}
				</button>
			</div>
		</section>
	);
}

interface BrowserViewHostProps {
	link: MachineLink;
	takeover: BrowserTakeover;
	ai: string;
	online: boolean;
	/** Inside a session (a large area over it on a wide screen), else over the whole page. */
	inSession: boolean;
	onMinimize: () => void;
}

/** The live view, loaded on first use. */
export function BrowserViewHost(props: BrowserViewHostProps) {
	return (
		<Suspense fallback={<div className={`mx-browser${props.inSession ? " in-session" : ""}`} aria-busy="true" />}>
			<TakeoverView {...props} />
		</Suspense>
	);
}

/**
 * Asks the machine to open its running browser for this device; resolves
 * with the takeover (the machine also announces it to every device).
 */
export async function openMachineBrowser(link: MachineLink): Promise<BrowserTakeover | null> {
	const frame = await link.request({ case: "browserControl", value: {} });
	return frame.body.case === "browserTakeover" ? frame.body.value : null;
}

interface BrowserDockProps {
	link: MachineLink;
	takeovers: readonly BrowserTakeover[];
	notices: readonly PasskeyNotice[];
	ai: string;
	/** Opens the live view of a takeover. */
	onView: (takeoverId: string) => void;
}

/** Above the composer: the takeover the AI waits on, and pages that asked for a passkey. */
export function BrowserDock({ link, takeovers, notices, ai, onView }: BrowserDockProps) {
	const t = useMachinesCopy();
	const [error, setError] = useState("");
	const first = takeovers[0];
	const notice = notices.at(-1);
	// A passkey page: the takeover open for it, else the user opens the browser now.
	const takeOver = () => {
		if (first !== undefined) return onView(first.takeoverId);
		setError("");
		openMachineBrowser(link).then(
			(opened) => {
				if (opened !== null) onView(opened.takeoverId);
			},
			(err: unknown) => setError(errorText(t, err, ai)),
		);
	};
	return (
		<section className="mx-dock" aria-label={t.browser.viewTitle}>
			<div className="mx-dock-inner mx-browser-card">
				{first !== undefined && (
					<TakeoverCard
						takeover={first}
						ai={ai}
						onOpen={() => onView(first.takeoverId)}
						onGiveBack={async () => {
							await link.request({ case: "browserTakeoverEnd", value: { takeoverId: first.takeoverId } });
							link.dropTakeover(first.takeoverId);
						}}
					/>
				)}
				{notice !== undefined && <PasskeyCard notice={notice} ai={ai} onOpen={takeOver} onDismiss={() => link.dismissPasskey(notice)} />}
				{error !== "" && (
					<p className="mx-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</section>
	);
}
