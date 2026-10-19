import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { applyStoredAppearance } from "./appearance.ts";
import { installErrorReporter, reportClientError } from "./error-reporter.ts";
import { captureInstallPrompt } from "./install-prompt.ts";
import { registerServiceWorker } from "./register-service-worker.ts";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

installErrorReporter();
applyStoredAppearance();
// The browser announces installability once, early; Settings › Cài ứng dụng uses it later.
captureInstallPrompt();

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container, {
	// Replaces React's default report (console and window "error"): counted once, as a render error.
	onUncaughtError: (error) => {
		console.error(error);
		reportClientError("render", error);
	},
}).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

registerServiceWorker();
