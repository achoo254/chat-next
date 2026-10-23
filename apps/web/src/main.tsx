import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { applyStoredAppearance } from "./appearance.ts";
import { installErrorReporter, reportClientError } from "./error-reporter.ts";
import { captureInstallPrompt } from "./install-prompt.ts";
import { registerServiceWorker } from "./register-service-worker.ts";
import type { RpcFetch } from "./api/client.ts";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

installErrorReporter();
applyStoredAppearance();
// The browser announces installability once, early; Settings › Cài ứng dụng uses it later.
captureInstallPrompt();

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

function render(root: HTMLElement, rpcFetch?: RpcFetch): void {
	createRoot(root, {
		// Replaces React's default report (console and window "error"): counted once, as a render error.
		onUncaughtError: (error) => {
			console.error(error);
			reportClientError("render", error);
		},
	}).render(
		<StrictMode>
			<App rpcFetch={rpcFetch} />
		</StrictMode>,
	);
}

if (import.meta.env.VITE_NATIVE === "true") {
	// The app bundles its files and has no Web Push: no service worker. Its
	// requests carry the session token kept in the Keychain or Keystore.
	void import("./native/native-app.ts").then(async (native) => {
		await native.startNative();
		render(container, native.nativeFetch);
	});
} else {
	render(container);
	registerServiceWorker();
}
