import "@achoo254/app-switcher/app-switcher.css";
import { AppSwitcher, type AppSwitcherPlacement } from "@achoo254/app-switcher";
import { openExternal } from "@achoo254/chat-platform-web";
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
 * (`@achoo254/app-switcher`). Signed-in screens only: the settings rail
 * (Shell), the folder rail and the narrow chat list's top bar.
 */
export function EcosystemAppSwitcher({ placement, className }: EcosystemAppSwitcherProps) {
	const { locale } = useI18n();
	return (
		<AppSwitcher
			current="chat"
			domain={brand.domain}
			locale={locale}
			placement={placement}
			onOpen={IS_NATIVE ? openInSystemBrowser : undefined}
			className={className}
		/>
	);
}
