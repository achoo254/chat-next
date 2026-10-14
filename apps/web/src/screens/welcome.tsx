import { brand } from "../brand.ts";
import { Icon } from "../components/icon.tsx";
import { useI18n, type Locale } from "../i18n/i18n.tsx";
import { rememberReturnPath } from "../router.tsx";

const LANGUAGES: { locale: Locale; label: string }[] = [
	{ locale: "vi", label: "Tiếng Việt" },
	{ locale: "en", label: "English" },
];

/** Sign-in URL handled by the server; it redirects to the IdP with ui_locales. */
export function loginUrl(locale: Locale, create = false): string {
	const params = new URLSearchParams();
	if (create) params.set("prompt", "create");
	params.set("locale", locale);
	return `/auth/login?${params.toString()}`;
}

/** Signed-out screen: sign in or create an account at the IdP. */
export function Welcome() {
	const { locale, t, setLocale } = useI18n();
	// Sign-in comes back to "/"; this page (e.g. an invite link) opens again afterwards.
	const keepPage = () => rememberReturnPath(window.location.pathname);
	return (
		<main className="welcome">
			<section className="welcome-card" aria-labelledby="welcome-title">
				<span className="brand-mark" aria-hidden="true">
					<Icon name="message" />
				</span>
				<h1 id="welcome-title">{brand.appName}</h1>
				<p>{brand.description}</p>
				<div className="welcome-actions">
					<a className="btn btn-primary" href={loginUrl(locale)} onClick={keepPage}>
						{t.welcome.signIn}
					</a>
					<a className="btn" href={loginUrl(locale, true)} onClick={keepPage}>
						{t.welcome.createAccount}
					</a>
				</div>
				<div className="welcome-hint">
					<Icon name="shield" small />
					<span>{t.welcome.hint(brand.idpHost)}</span>
				</div>
				<div className="welcome-foot">
					<span>{brand.idpHost}</span>
					<div className="lang" role="group" aria-label={t.welcome.language}>
						{LANGUAGES.map((language) => (
							<button
								key={language.locale}
								type="button"
								lang={language.locale}
								aria-pressed={language.locale === locale}
								onClick={() => setLocale(language.locale)}
							>
								{language.label}
							</button>
						))}
					</div>
				</div>
			</section>
		</main>
	);
}
