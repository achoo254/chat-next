// Frame of Chat's public pages (welcome, /login, /privacy, /terms,
// /delete-account): the shared header, footer and page of every hoandat.com
// app (@achoo254/app-shell), so Chat's chrome cannot drift from the others.
// Chat gives its name, mark, links and language; the body is its own.
// app-shell.css loads with these lazy screens (and the Appearance settings),
// not at a signed-in start.
import { PublicPage, type ShellBrand, type ShellLinkComponent } from "@achoo254/app-shell";
import "@achoo254/app-shell/app-shell.css";
import type { ReactNode } from "react";
import { LEGACY_THEME_KEY } from "../appearance.ts";
import { brand } from "../brand.ts";
import { LOCALES, useI18n } from "../i18n/i18n.tsx";
import { followInApp, paths, usePathname } from "../router.tsx";

/** What the shared shell shows of Chat: name, root domain, AI mark (the brand icon the build serves). */
export const SHELL_BRAND: ShellBrand = {
	appName: brand.appName,
	domain: brand.domain,
	markSrc: "/icon.svg",
};

/**
 * Chat's own pages open in place, without a reload. The shell hands it only
 * paths the router renders: the sign-in card's call to action, a server
 * route (/auth/login), never gets it.
 */
const RouterLink: ShellLinkComponent = ({ href, onClick, children, ...rest }) => (
	<a
		{...rest}
		href={href}
		onClick={(event) => {
			onClick?.(event);
			followInApp(event, href);
		}}
	>
		{children}
	</a>
);

export function ChatPublicPage({ children, layout = "flow" }: { children: ReactNode; layout?: "flow" | "center" }) {
	const { locale, t, followStoredLocale } = useI18n();
	const pathname = usePathname();
	return (
		<PublicPage
			brand={SHELL_BRAND}
			locale={locale}
			locales={LOCALES}
			onLocaleChange={followStoredLocale}
			signInHref={paths.login}
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
			linkComponent={RouterLink}
			layout={layout}
		>
			{children}
		</PublicPage>
	);
}
