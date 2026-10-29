// Frame of Chat's public pages (welcome, /login, /privacy, /terms,
// /delete-account): the shared header, footer and page of every hoandat.com
// app (@achoo254/app-shell), so Chat's chrome cannot drift from the others.
// Chat gives its name, mark, links and language; the body is its own.
// app-shell.css also styles the signed-in screens' account menu.
import { PublicPage, type ShellBrand } from "@achoo254/app-shell";
import "@achoo254/app-shell/app-shell.css";
import type { ReactNode } from "react";
import { LEGACY_THEME_KEY } from "../appearance.ts";
import { brand } from "../brand.ts";
import { LOCALES, useI18n } from "../i18n/i18n.tsx";
import { paths, returnPathFor, usePathname, useSearch } from "../router.tsx";
import { loginUrl } from "../screens/welcome-url.ts";
import { ShellRouterLink } from "./shell-router-link.tsx";

/** What the shared shell shows of Chat: name, root domain, AI mark (the brand icon the build serves). */
export const SHELL_BRAND: ShellBrand = {
	appName: brand.appName,
	domain: brand.domain,
	markSrc: "/icon.svg",
};

/**
 * The header's "Đăng nhập": /login, except on the web on a page sign-in
 * should come back to (an invite, a chat, a bot link), where it signs in
 * straight away like the card does, so the visitor lands back on that page.
 * The iPhone and Android apps sign in through the card's system browser.
 */
function headerSignInHref(locale: Parameters<typeof loginUrl>[0], pathname: string, search: string): string {
	if (import.meta.env.VITE_NATIVE === "true") return paths.login;
	return returnPathFor(pathname, search) === undefined ? paths.login : loginUrl(locale, pathname, search);
}

export function ChatPublicPage({ children, layout = "flow" }: { children: ReactNode; layout?: "flow" | "center" }) {
	const { locale, t, followStoredLocale } = useI18n();
	const pathname = usePathname();
	const search = useSearch();
	return (
		<PublicPage
			brand={SHELL_BRAND}
			locale={locale}
			locales={LOCALES}
			onLocaleChange={followStoredLocale}
			signInHref={headerSignInHref(locale, pathname, search)}
			signInCurrent={pathname === paths.login}
			privacyHref={paths.privacy}
			termsHref={paths.terms}
			footerLinks={[
				{
					href: paths.deleteAccount,
					label: t.legal.deleteAccount,
					dataId: "foot-delete-account",
					current: pathname === paths.deleteAccount,
				},
			]}
			legacyThemeKey={LEGACY_THEME_KEY}
			linkComponent={ShellRouterLink}
			layout={layout}
		>
			{children}
		</PublicPage>
	);
}
