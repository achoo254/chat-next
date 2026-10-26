import { signInUrl } from "@achoo254/chat-core";
import { brand } from "../brand.ts";
import { BrandLogo } from "../components/brand-loader.tsx";
import { LanguageSwitch } from "../components/language-switch.tsx";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n, type Locale } from "../i18n/i18n.tsx";
import { Link, paths, returnPathFor } from "../router.tsx";

/**
 * Sign-in URL handled by the server; it redirects to the IdP with ui_locales
 * and, after sign-in, back to the page this visitor opened (return_to).
 */
export function loginUrl(locale: Locale, create = false, pathname = window.location.pathname, search = window.location.search): string {
	const returnTo = returnPathFor(pathname, search);
	return signInUrl(locale, { create, ...(returnTo === undefined ? {} : { returnTo }) });
}

/** Signed-out screen: sign in or create an account at the IdP. */
export function Welcome() {
	const { locale, t } = useI18n();
	return (
		<main className="welcome">
			<div className="welcome-stack">
				<section className="welcome-card" aria-labelledby="welcome-title">
					<BrandLogo decorative />
					<h1 id="welcome-title">{brand.appName}</h1>
					<p>{brand.description}</p>
					<div className="welcome-actions">
						<a className="btn btn-primary" href={loginUrl(locale)}>
							{t.welcome.signIn}
						</a>
						<a className="btn" href={loginUrl(locale, true)}>
							{t.welcome.createAccount}
						</a>
					</div>
					<div className="welcome-hint">
						<Icon name="shield" small />
						<span>{t.welcome.hint(brand.idpHost)}</span>
					</div>
				</section>
				{/* Under the card, not in it: the card holds only signing in. */}
				<footer className="welcome-foot">
					<LanguageSwitch />
					<nav className="welcome-legal" aria-label={t.legal.nav}>
						<Link to={paths.privacy}>{t.legal.privacy}</Link>
						<Link to={paths.terms}>{t.legal.terms}</Link>
						<Link to={paths.deleteAccount}>{t.legal.deleteAccount}</Link>
					</nav>
				</footer>
			</div>
		</main>
	);
}
