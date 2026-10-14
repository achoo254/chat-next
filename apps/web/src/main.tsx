import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createWebTransport } from "./api/client.ts";
import { App } from "./app.tsx";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container).render(
	<StrictMode>
		<App transport={createWebTransport()} />
	</StrictMode>,
);
