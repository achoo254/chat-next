// Where the chat server is. The web app is served by the server itself, so
// it is the page's own origin. The iOS and Android apps (Capacitor, built
// with VITE_NATIVE=true) load the same bundle from capacitor://localhost or
// https://localhost and call the server cross-origin: VITE_API_ORIGIN, or
// the web host of brand.config.json.
//
// IS_NATIVE is a build-time constant. A dynamic import of a native module
// must test `import.meta.env.VITE_NATIVE === "true"` in place rather than
// IS_NATIVE: the bundler folds the inline test, drops the branch and never
// emits the native chunks into the web build.
import brandConfig from "../../../brand.config.json";

export const IS_NATIVE = import.meta.env.VITE_NATIVE === "true";

/** The web origin of brand.config.json, e.g. https://chat.<domain>. */
function primaryWebOrigin(): string {
	return `https://${brandConfig.hostTemplates.web.replace("{domain}", brandConfig.primaryTenant.domain)}`;
}

/** Origin of the chat server the native app talks to; "" on the web. */
export const NATIVE_API_ORIGIN: string = IS_NATIVE
	? new URL(import.meta.env.VITE_API_ORIGIN || primaryWebOrigin()).origin
	: "";

/** Origin of the chat server, e.g. https://chat.hoandat.com. */
export function serverOrigin(): string {
	return IS_NATIVE ? NATIVE_API_ORIGIN : window.location.origin;
}

/** Host name of the chat server (no port), e.g. chat.hoandat.com. */
export function serverHostname(): string {
	return IS_NATIVE ? new URL(NATIVE_API_ORIGIN).hostname : window.location.hostname;
}

/** Host of the chat server (its web host), e.g. chat.hoandat.com. */
export function serverHost(): string {
	return IS_NATIVE ? new URL(NATIVE_API_ORIGIN).host : window.location.host;
}
