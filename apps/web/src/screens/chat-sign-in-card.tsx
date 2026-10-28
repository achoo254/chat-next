import { SignInCard } from "@achoo254/app-shell";
import { useState } from "react";
import { SHELL_BRAND } from "../components/chat-public-page.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { WELCOME_COPY } from "./welcome-copy.ts";
import { loginUrl } from "./welcome-url.ts";

/**
 * The shared sign-in card (@achoo254/app-shell) with Chat's sign-in behind
 * its one call to action: the web follows the server's /auth/login to the
 * IdP and back to the page the visitor opened (return_to); the iPhone and
 * Android apps run it in the system browser (native-app.ts), and the call
 * to action stays busy until the browser closes.
 */
export function ChatSignInCard({ headingLevel }: { headingLevel?: 1 | 2 }) {
	const { locale } = useI18n();
	const t = WELCOME_COPY[locale];
	const [pending, setPending] = useState(false);

	// The web build has no native layer: the condition is a build-time constant.
	const onSignIn =
		import.meta.env.VITE_NATIVE === "true"
			? (href: string) => {
					setPending(true);
					void import("../native/native-app.ts")
						.then((native) => native.signInFromLink(href))
						.finally(() => setPending(false));
				}
			: undefined;

	return (
		<SignInCard
			brand={SHELL_BRAND}
			locale={locale}
			signInHref={loginUrl(locale)}
			onSignIn={onSignIn}
			pending={pending}
			title={t.signInTitle}
			description={t.signInBody}
			headingLevel={headingLevel}
		/>
	);
}
