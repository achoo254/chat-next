// The one frame every way of connecting an app is drawn in (Chat Bridge, ADR 0022):
// a head with the app's mark, the step's title and how this app signs in, then the
// step's own body, one status line, and the actions in the same place and order
// (the way forward first, Huỷ last). A login by fields (Telegram), the notice before
// a QR login and the QR code itself (Zalo) only fill the slots, so the two methods
// cannot drift apart in layout, wording of the status or buttons.
import type { FormEvent, ReactNode, Ref } from "react";
import { useId } from "react";
import { initials } from "../../components/avatar.tsx";
import { Icon } from "../../components/screen-icons.tsx";

/** How the status line reads: a plain hint, a problem, or good news. */
export type SignInTone = "info" | "error" | "success";

export interface SignInStatus {
	readonly text: ReactNode;
	readonly tone: SignInTone;
	/** The state machine's own name for the status, kept as data-state for tests and styling. */
	readonly state?: string | undefined;
}

export function BridgeSignInFrame({
	dataId,
	appName,
	method,
	title,
	headingRef,
	status,
	actions,
	onSubmit,
	children,
}: {
	dataId: string;
	appName: string;
	/** How this app signs in ("by phone number", "by QR code"), under the title. */
	method: string;
	title: string;
	/** Focus lands here when a new step opens. */
	headingRef?: Ref<HTMLHeadingElement>;
	/** The live line under the body; omitted when there is nothing to say. */
	status?: SignInStatus | undefined;
	actions: ReactNode;
	/** Given for a step with fields: the frame is a form and Enter submits it. */
	onSubmit?: (event: FormEvent) => void;
	children: ReactNode;
}) {
	const titleId = useId();
	const content = (
		<>
			<header className="br-head br-signin-head">
				<span className="avatar av-blue" aria-hidden="true">
					{initials(appName)}
				</span>
				<span className="grow br-text">
					<h2 className="br-signin-title" id={titleId} ref={headingRef} tabIndex={-1}>
						{title}
					</h2>
					<small>{method}</small>
				</span>
			</header>
			<div className="br-signin-body">{children}</div>
			{status !== undefined && (
				<p
					className="br-signin-status"
					role={status.tone === "error" ? "alert" : "status"}
					aria-live="polite"
					data-id={`${dataId}-status`}
					data-tone={status.tone}
					data-state={status.state}
				>
					{status.tone === "error" && <Icon name="alert" small />}
					<span>{status.text}</span>
				</p>
			)}
			<div className="br-signin-actions">{actions}</div>
		</>
	);
	return onSubmit !== undefined ? (
		<form className="card br-account br-signin" data-id={dataId} aria-labelledby={titleId} onSubmit={onSubmit} noValidate>
			{content}
		</form>
	) : (
		<section className="card br-account br-signin" data-id={dataId} aria-labelledby={titleId}>
			{content}
		</section>
	);
}
