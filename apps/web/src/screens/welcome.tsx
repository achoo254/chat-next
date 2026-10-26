import { brand } from "../brand.ts";
import { BrandLogo } from "../components/brand-loader.tsx";
import { PublicPage } from "../components/public-chrome.tsx";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { loginUrl } from "./welcome-url.ts";

/**
 * Signed-out screen, in the account app's layout: a short intro (what the
 * app does, three points) next to the card that signs in or creates an
 * account at the IdP.
 */
export function Welcome() {
	const { locale, t } = useI18n();
	return (
		<PublicPage className="welcome-hero">
			<section className="welcome-intro" aria-labelledby="welcome-title" data-id="welcome-intro">
				<p className="pub-eyebrow">{t.welcome.eyebrow}</p>
				<h1 id="welcome-title">{t.welcome.title}</h1>
				<p className="welcome-lede">{t.welcome.lede}</p>
				<ul className="pub-checks">
					{t.welcome.points.map((point) => (
						<li key={point}>{point}</li>
					))}
				</ul>
			</section>
			<section className="welcome-card" aria-labelledby="welcome-card-title" data-id="welcome-card">
				<BrandLogo decorative />
				<h2 id="welcome-card-title">{brand.appName}</h2>
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
		</PublicPage>
	);
}
