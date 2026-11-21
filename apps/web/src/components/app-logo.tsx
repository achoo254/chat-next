// The logo of an app Chat is synced with, for a chip that must stay small (the chat list row).
// Only apps with a drawn logo are here; for any other app the caller falls back to its name.
const LOGOS: Record<string, { readonly color: string; readonly path: string }> = {
	// Telegram: the paper plane in its blue circle.
	telegram: {
		color: "#229ED9",
		path: "M5.2 11.9 17.3 7.2c.56-.2 1.05.14.87.98l-2.06 9.7c-.15.69-.56.86-1.13.54l-3.14-2.32-1.5 1.46c-.17.17-.31.31-.63.31l.23-3.2 5.82-5.26c.25-.23-.05-.35-.4-.13l-7.2 4.53-3.1-.97c-.67-.21-.68-.67.14-.99Z",
	},
};

/** True when a logo is drawn for `app` (its id, e.g. "telegram"). */
export function hasAppLogo(app: string): boolean {
	return LOGOS[app] !== undefined;
}

/** The logo of `app`, sized to the text around it; nothing when none is drawn. */
export function AppLogo({ app, size = 16 }: { app: string; size?: number }) {
	const logo = LOGOS[app];
	if (logo === undefined) return null;
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<circle cx="12" cy="12" r="12" fill={logo.color} />
			<path d={logo.path} fill="#fff" />
		</svg>
	);
}
