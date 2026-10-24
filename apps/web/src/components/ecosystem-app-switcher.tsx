import "@shared-next/app-switcher/app-switcher.css";
import { AppSwitcher, type AppSwitcherPlacement } from "@shared-next/app-switcher";
import { openExternal } from "@app/platform-web";
import { brand } from "../brand.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { IS_NATIVE } from "../server-origin.ts";

/** The native app hands the other apps to the system browser, never its WebView. */
function openInSystemBrowser(url: string): void {
	openExternal(url, brand.urlScheme);
}

interface EcosystemAppSwitcherProps {
	/** "right-end" beside a side rail, "bottom-end" under a top bar. */
	placement: AppSwitcherPlacement;
	/** Where it sits, for the layout rules of app.css and messaging.css. */
	className: string;
}

/**
 * The 9-dot button listing the other apps the same account signs in to
 * (`@shared-next/app-switcher`). Signed-in screens only: the settings rail
 * (Shell), the folder rail and the narrow chat list's top bar.
 */
export function EcosystemAppSwitcher({ placement, className }: EcosystemAppSwitcherProps) {
	const { locale } = useI18n();
	return (
		<AppSwitcher
			current="chat"
			tenantDomain={brand.domain}
			// Scribe runs on the primary tenant (hoandat.com) only: chat.<domain> of
			// another tenant or a self-hosted install lists the other apps without it.
			isPrimaryTenant={brand.primaryTenant}
			locale={locale}
			placement={placement}
			onOpen={IS_NATIVE ? openInSystemBrowser : undefined}
			className={className}
		/>
	);
}
