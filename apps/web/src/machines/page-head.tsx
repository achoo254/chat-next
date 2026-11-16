// The header of an AI Agent page: a back link (phones, or where a page
// has a parent), the title and a subtitle, then the page's own actions.
import type { ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { BackLink, Link } from "../router.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

/**
 * `backAlways`: the page is a child no column shows (e.g. "Tài khoản AI" under "Cài đặt máy"), so the back link stays on wide screens too.
 * `backToOrigin`: a page opened from several places (the machine's terminal): back returns to where it was opened from, `back` when opened directly.
 */
export function PageHead({
	back,
	backLabel,
	backAlways = false,
	backToOrigin = false,
	title,
	subtitle,
	children,
}: {
	back?: string;
	backLabel?: string;
	backAlways?: boolean;
	backToOrigin?: boolean;
	title: ReactNode;
	subtitle?: ReactNode;
	children?: ReactNode;
}) {
	const t = useMachinesCopy();
	const className = backAlways ? "icon-btn mx-back always" : "icon-btn mx-back";
	return (
		<header className="mx-head">
			{back !== undefined &&
				(backToOrigin ? (
					<BackLink fallback={back} className={className} label={backLabel ?? t.back}>
						<Icon name="back" />
					</BackLink>
				) : (
					<Link to={back} className={className} aria-label={backLabel ?? t.back}>
						<Icon name="back" />
					</Link>
				))}
			<div className="title">
				<strong>{title}</strong>
				{subtitle !== undefined && <span>{subtitle}</span>}
			</div>
			{children}
		</header>
	);
}
