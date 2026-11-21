// "This needs a sign-in from the last 10 minutes": the banner a bridge page shows when the
// server answers a risky call with reauth_required, with the link that signs in again and
// comes back to `returnTo`. Shared by the settings page and a synced chat's info panel.
import { signInUrl } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";

export function BridgeReauthBanner({ returnTo }: { returnTo: string }) {
	const t = useBridgeCopy();
	const { locale } = useI18n();
	return (
		<div className="banner" role="alert">
			<Icon name="lock" small />
			<span className="grow">{t.reauth.body}</span>
			<a className="btn btn-sm" href={signInUrl(locale, { reauth: true, returnTo })}>
				{t.reauth.signIn}
			</a>
		</div>
	);
}
