/// <reference types="vite/client" />

/** The brand icon as inline SVG markup (vite-brand.ts). */
declare module "virtual:brand-logo" {
	const svg: string;
	export default svg;
}

/** When the app was built, Unix ms (vite.config.ts define). */
declare const __APP_BUILD_TIME__: number;
