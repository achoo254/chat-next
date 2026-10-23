/// <reference types="vite/client" />

/** The brand icon as inline SVG markup (vite-brand.ts). */
declare module "virtual:brand-logo" {
	const svg: string;
	export default svg;
}

interface ImportMetaEnv {
	/** "true" builds the bundle for the Capacitor app (server-origin.ts). */
	readonly VITE_NATIVE?: string;
	/** Chat server the native app calls, e.g. https://chat.hoandat.com. */
	readonly VITE_API_ORIGIN?: string;
	/** Version of the native app, shown in the session list (ExchangeNativeCode). */
	readonly VITE_APP_VERSION?: string;
}
