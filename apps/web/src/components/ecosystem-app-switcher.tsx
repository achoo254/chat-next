import "@achoo254/app-switcher/app-switcher.css";
import type { AppSwitcherPlacement } from "@achoo254/app-switcher";
import { lazy, Suspense } from "react";
import { brand } from "../brand.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { OPEN_EXTERNAL } from "./open-in-system-browser.ts";

// The switcher (catalog copy in three languages, popover) loads in its own
// chunk, outside the startup JS budget (test/perf/budgets.ts); nobody opens it
// in the first moments of a session.
const AppSwitcher = lazy(() => import("@achoo254/app-switcher").then((module) => ({ default: module.AppSwitcher })));

interface EcosystemAppSwitcherProps {
	/** "right-end" beside a side rail, "bottom-end" under a top bar. */
	placement: AppSwitcherPlacement;
	/** Where it sits, for the layout rules of app.css and messaging.css. */
	className: string;
}

/**
 * The 9-dot button listing the other apps the same account signs in to
 * (`@achoo254/app-switcher`). Signed-in screens only: the settings rail
 * (Shell), the folder rail and the narrow chat list's top bar. Until its chunk
 * arrives an empty box of the button's size holds the place, so the rail does
 * not shift.
 */
export function EcosystemAppSwitcher({ placement, className }: EcosystemAppSwitcherProps) {
	const { locale } = useI18n();
	return (
		<Suspense
			fallback={
				<span className={`sn-app-switcher ${className}`} aria-hidden="true">
					<span className="sn-app-switcher__button" />
				</span>
			}
		>
			<AppSwitcher
				current="chat"
				domain={brand.domain}
				locale={locale}
				placement={placement}
				onOpen={OPEN_EXTERNAL}
				className={className}
			/>
		</Suspense>
	);
}
