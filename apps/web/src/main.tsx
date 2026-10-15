import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { applyStoredAppearance } from "./appearance.ts";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

applyStoredAppearance();

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
