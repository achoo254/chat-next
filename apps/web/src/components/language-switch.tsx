import { useI18n, type Locale } from "../i18n/i18n.tsx";

const LANGUAGES: { locale: Locale; label: string }[] = [
	{ locale: "vi", label: "Tiếng Việt" },
	{ locale: "en", label: "English" },
];

/** Tiếng Việt / English, for screens shown before sign-in (welcome, public pages). */
export function LanguageSwitch() {
	const { locale, t, setLocale } = useI18n();
	return (
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
	);
}
