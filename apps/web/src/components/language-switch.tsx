import { useI18n, type Locale } from "../i18n/i18n.tsx";

const LANGUAGES: { locale: Locale; label: string }[] = [
	{ locale: "vi", label: "Tiếng Việt" },
	{ locale: "en", label: "English" },
];

/** Tiếng Việt / English, for screens shown before sign-in (welcome, public pages); the account app's pill (public.css). */
export function LanguageSwitch() {
	const { locale, t, setLocale } = useI18n();
	return (
		<div className="lang-switch" role="group" data-id="lang-switch" aria-label={t.welcome.language}>
			{LANGUAGES.map((language) => (
				<button
					key={language.locale}
					type="button"
					className="lang-option"
					lang={language.locale}
					aria-pressed={language.locale === locale}
					onClick={() => setLocale(language.locale)}
				>
					{language.label}
				</button>
			))}
		</div>
	);
}
