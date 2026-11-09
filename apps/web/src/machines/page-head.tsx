// The header of an AI Agent page: a back link (phones, or where a page
// has a parent), the title and a subtitle, then the page's own actions.
import type { ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link } from "../router.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function PageHead({ back, backLabel, title, subtitle, children }: { back?: string; backLabel?: string; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
	const t = useMachinesCopy();
	return (
		<header className="mx-head">
			{back !== undefined && (
				<Link to={back} className="icon-btn mx-back" aria-label={backLabel ?? t.back}>
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
