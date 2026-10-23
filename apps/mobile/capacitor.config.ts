// Capacitor shell of the chat web app (docs/mobile-app.md). The app id and
// name come from the brand (pnpm brand:gen writes brand/generated/), the
// bundle is the web app built with VITE_NATIVE=true into www/
// (pnpm mobile:build-web), and sign-in runs in the system browser through
// @shared-next/capacitor-system-auth.
import type { CapacitorConfig } from "@capacitor/cli";
import brand from "../../brand/generated/capacitor.json" with { type: "json" };

const config: CapacitorConfig = {
	appId: brand.appId,
	appName: brand.appName,
	webDir: "www",
};

export default config;
