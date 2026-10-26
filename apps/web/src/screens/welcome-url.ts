import { signInUrl } from "@achoo254/chat-core";
import type { Locale } from "../i18n/i18n.tsx";
import { returnPathFor } from "../router.tsx";

/**
 * Sign-in URL handled by the server; it redirects to the IdP with ui_locales
 * and, after sign-in, back to the page this visitor opened (return_to).
 */
export function loginUrl(locale: Locale, create = false, pathname = window.location.pathname, search = window.location.search): string {
	const returnTo = returnPathFor(pathname, search);
	return signInUrl(locale, { create, ...(returnTo === undefined ? {} : { returnTo }) });
}
