import type { ReactNode } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { Icon } from "./screen-icons.tsx";

/** Link to another site (the IdP), opened in a new tab without an opener. */
export function ExternalLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
	const { t } = useI18n();
	return (
		<a className={className} href={href} target="_blank" rel="noopener noreferrer">
			{children} <Icon name="external" small />
			<span className="sr-only">{t.common.newTab}</span>
		</a>
	);
}
