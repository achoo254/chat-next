// Feature flags of the web app. Messaging (release R1) ships dark: production
// builds keep the R0 shell until the backend is live. Testers turn it on in
// their own browser with localStorage["feature:messaging"] = "1" ("0" forces it
// off on a build that enables it).

export const MESSAGING_FLAG_KEY = "feature:messaging";

function storedOverride(): boolean | null {
	try {
		const value = window.localStorage.getItem(MESSAGING_FLAG_KEY);
		if (value === "1") return true;
		if (value === "0") return false;
		return null;
	} catch {
		// Storage can be blocked by privacy settings; the build default applies.
		return null;
	}
}

/** Whether this browser shows the messaging UI (read once per page load). */
export function messagingEnabled(): boolean {
	return storedOverride() ?? import.meta.env.VITE_FEATURE_MESSAGING === "1";
}
