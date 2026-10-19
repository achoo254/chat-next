// Settings › Cài ứng dụng (mockups/settings.html#app): the browser's own
// install dialog where it has one, the home screen steps on iPhone and iPad,
// "installed" inside the installed app, the browser menu elsewhere.
import { useSyncExternalStore } from "react";
import { brand } from "../../brand.ts";
import { BrandLogo } from "../../components/brand-loader.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { installState, promptInstall, subscribeInstall } from "../../install-prompt.ts";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";

export function InstallSettings() {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const state = useSyncExternalStore(subscribeInstall, installState);
	const t = copy.install;

	const install = () => {
		promptInstall().then(
			(outcome) => {
				if (outcome === "accepted") toasts.show(t.accepted);
			},
			() => toasts.show(copy.common.failed),
		);
	};

	return (
		<div className="set-body" data-id="install">
			{state === "installed" && (
				<div className="banner ok" role="status">
					<Icon name="check" small />
					<span className="grow">{t.installed(brand.appName)}</span>
				</div>
			)}
			{state === "prompt" && (
				<>
					<div className="card pad install-card">
						<BrandLogo decorative />
						<div className="grow">
							<b>{brand.appName}</b>
							<p className="note">{t.pitch}</p>
						</div>
						<button type="button" className="btn btn-primary" data-id="install-button" onClick={install}>
							<Icon name="download" />
							{t.install}
						</button>
					</div>
					<p className="note">
						{t.afterBefore}{" "}
						<Link to={paths.settings("notifications")} className="link">
							{t.afterLink}
						</Link>{" "}
						{t.afterAfter}
					</p>
				</>
			)}
			{state === "ios" && (
				<div className="card pad install-steps">
					<b>{t.iosTitle}</b>
					<ol className="steps">
						{t.iosSteps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
					<p className="note">{t.iosNote}</p>
				</div>
			)}
			{state === "manual" && (
				<div className="card pad">
					<p className="note">{t.manual}</p>
				</div>
			)}
		</div>
	);
}
