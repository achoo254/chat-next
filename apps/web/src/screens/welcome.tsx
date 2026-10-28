import { FeatureList, Hero } from "@achoo254/app-shell";
import { ChatPublicPage } from "../components/chat-public-page.tsx";
import { Icon, type IconName } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { matchSignIn, usePathname } from "../router.tsx";
import { ChatSignInCard } from "./chat-sign-in-card.tsx";
import { WELCOME_COPY, type WelcomeCopy } from "./welcome-copy.ts";

/** Feature cards, in order, with their icons. */
const FEATURES: readonly { id: keyof WelcomeCopy["features"]; icon: IconName }[] = [
	{ id: "sync", icon: "message" },
	{ id: "search", icon: "search" },
	{ id: "bots", icon: "robot" },
];

/**
 * Signed-out start, on the web and in the iPhone and Android apps: what the
 * app does beside the shared sign-in card (the page's one call to action),
 * then its features, in the shared frame of every hoandat.com app.
 */
function Welcome() {
	const t = WELCOME_COPY[useI18n().locale];
	const { features } = t;
	return (
		<ChatPublicPage>
			<Hero eyebrow={t.eyebrow} title={t.title} lede={t.lede} aside={<ChatSignInCard headingLevel={2} />} />
			<FeatureList
				title={t.featuresTitle}
				items={FEATURES.map(({ id, icon }) => ({
					id,
					title: features[id].title,
					description: features[id].body,
					icon: <Icon name={icon} small />,
				}))}
			/>
		</ChatPublicPage>
	);
}

/** /login for visitors: the sign-in card alone, where the header's "Đăng nhập" leads. */
function SignIn() {
	return (
		<ChatPublicPage layout="center">
			<ChatSignInCard />
		</ChatPublicPage>
	);
}

/** Signed out: the sign-in card alone on /login, the welcome page on any other path (which sign-in returns to). */
export default function SignedOutPage() {
	return matchSignIn(usePathname()) ? <SignIn /> : <Welcome />;
}
