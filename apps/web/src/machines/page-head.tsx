// The header of an AI Agent page: a back link (phones, or where a page
// has a parent), the title and a subtitle, then the page's own actions.
import type { ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link } from "../router.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** `backAlways`: the page is a child no column shows (e.g. "Tài khoản AI" under "Cài đặt máy"), so the back link stays on wide screens too. */
export function PageHead({ back, backLabel, backAlways = false, title, subtitle, children }: { back?: string; backLabel?: string; backAlways?: boolean; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
	const t = useMachinesCopy();
	return (
		<header className="mx-head">
			{back !== undefined && (
				<Link to={back} className={backAlways ? "icon-btn mx-back always" : "icon-btn mx-back"} aria-label={backLabel ?? t.back}>
					<Icon name="back" />
				</Link>
			)}
			<div className="title">
				<strong>{title}</strong>
				{subtitle !== undefined && <span>{subtitle}</span>}
			</div>
			{children}
		</header>
	);
}
