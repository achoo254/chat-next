// A collapsible section of Source Control ("CHANGES 3", "COMMITS"): its
// header is a button that opens and closes it.
import { useState, type ReactNode } from "react";
import { MachineIcon } from "../../machine-icons.tsx";

interface SectionProps {
	id: string;
	title: string;
	count?: number | undefined;
	/** A line under the title (the base a branch is compared with). */
	sub?: string;
	initiallyOpen?: boolean;
	children: ReactNode;
}

export function Section({ id, title, count, sub, initiallyOpen = true, children }: SectionProps) {
	const [open, setOpen] = useState(initiallyOpen);
	const body = `ws-sec-${id}`;
	return (
		<section className="ws-sec" aria-label={title} data-id={`workspace-section-${id}`}>
			<h3 className="ws-sec-head">
				<button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen((v) => !v)}>
					<MachineIcon name={open ? "chevron-down" : "chevron-right"} small />
					<span className="ws-sec-title">{title}</span>
					{count !== undefined && <span className="ws-count">{count}</span>}
					{sub !== undefined && sub !== "" && <span className="ws-sec-sub">{sub}</span>}
				</button>
			</h3>
			<div id={body} className="ws-sec-body" hidden={!open}>
				{children}
			</div>
		</section>
	);
}
