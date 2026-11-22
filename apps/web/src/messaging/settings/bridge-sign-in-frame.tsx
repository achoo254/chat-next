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
	warning = false,
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
	/** The step is a warning to read before going on (the notice before an unofficial login). */
	warning?: boolean;
	/** Focus lands here when a new step opens. */
	headingRef?: Ref<HTMLHeadingElement>;
	/** The line under the body; omitted when there is nothing to say. */
	status?: SignInStatus | undefined;
	actions: ReactNode;
	/** Given for a step with fields: the frame is a form and Enter submits it. */
	onSubmit?: (event: FormEvent) => void;
	children: ReactNode;
}) {
	const titleId = useId();
	const error = status?.tone === "error" ? status : undefined;
	const hint = status !== undefined && status.tone !== "error" ? status : undefined;
	const content = (
		<>
			<header className="br-head br-signin-head">
				<span className="avatar av-blue" aria-hidden="true">
					{initials(appName)}
				</span>
				<div className="grow br-text">
					<h2 className="br-signin-title" id={titleId} ref={headingRef} tabIndex={-1}>
						{warning && <Icon name="alert" small />}
						{title}
					</h2>
					<small>{method}</small>
				</div>
			</header>
			<div className="br-signin-body">{children}</div>
			{/* The polite region stays in the page (empty when quiet) so a new hint is read when it
			    appears; a problem goes in its own alert instead, so no region ever changes its role. */}
			<p
				className="br-signin-status"
				role="status"
				aria-live="polite"
				data-id={error === undefined ? `${dataId}-status` : undefined}
				data-tone={hint?.tone}
				data-state={hint?.state}
			>
				{hint?.text}
			</p>
			{error !== undefined && (
				<p className="br-signin-status" role="alert" data-id={`${dataId}-status`} data-tone="error" data-state={error.state}>
					<Icon name="alert" small />
					<span>{error.text}</span>
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
