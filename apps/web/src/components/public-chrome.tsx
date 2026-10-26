// Top bar and footer of the public pages (the signed-out welcome, /privacy,
// /terms, /delete-account), built like the account app at auth.<domain>, the
// base layout of every app of the brand: auth-next src/ui/layout.ts and the
// .topbar, .idp-brand, .topbar-link, .page-foot, .lang-switch and .foot-link
// rules of its static/css/app.css. Styles are public.css, loaded with these
// lazy screens only, so a signed-in start does not download them.
import type { ReactNode } from "react";
import { brand } from "../brand.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, paths } from "../router.tsx";
import { loginUrl } from "../screens/welcome-url.ts";
import { BrandLogo } from "./brand-loader.tsx";
import { LanguageSwitch } from "./language-switch.tsx";
import "../styles/public.css";

/** Sticky top bar: the AI mark (24px) and the bold app name, then "Đăng nhập" as the tinted pill. */
export function PublicHeader() {
	const { locale, t } = useI18n();
	return (
		<header className="topbar" data-id="public-header">
			<div className="topbar-inner pub-container">
				<Link to={paths.home} className="pub-brand">
					<BrandLogo decorative />
					<b>{brand.appName}</b>
				</Link>
				<nav className="topbar-nav" aria-label={t.publicChrome.nav}>
					<a className="topbar-link topbar-cta" href={loginUrl(locale)} data-id="public-sign-in">
						{t.publicChrome.signIn}
					</a>
				</nav>
			</div>
		</header>
	);
}

/** Under every public page: the language pill, then the brand line and the policies. */
export function PublicFooter() {
	const { t } = useI18n();
	return (
		<footer className="page-foot pub-container" data-id="public-footer">
			<LanguageSwitch />
			<nav className="foot-links" aria-label={t.publicChrome.footLinks}>
				<a className="foot-link" href={`https://${brand.domain}`} data-id="foot-home">
					{t.publicChrome.ecosystem}
				</a>
				<Link to={paths.privacy} className="foot-link">
					{t.legal.privacy}
				</Link>
				<Link to={paths.terms} className="foot-link">
					{t.legal.terms}
				</Link>
				<Link to={paths.deleteAccount} className="foot-link">
					{t.legal.deleteAccount}
				</Link>
			</nav>
		</footer>
	);
}

/** Header, the page body in the shared container, footer; on the grid backdrop of the account app. */
export function PublicPage({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="pub">
			<PublicHeader />
			<main className={className === undefined ? "pub-main pub-container" : `pub-main pub-container ${className}`}>{children}</main>
			<PublicFooter />
		</div>
	);
}
