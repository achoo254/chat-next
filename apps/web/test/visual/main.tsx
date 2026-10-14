// Visual harness for render checks of the messaging UI: the real app and
// client core against the core's in-memory protocol server, in the browser.
// Test-only: never part of the production build. ?theme=dark|light forces a
// theme; the path picks the screen (/c/5001, /settings/privacy, ...).
import { createRouterTransport } from "@connectrpc/connect";
import { openMemoryFactory } from "../../../../packages/platform-web/src/driver.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/app.tsx";
import { MESSAGING_FLAG_KEY } from "../../src/features.ts";
import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";
import { seedDemo } from "../support/demo-data.ts";
import { fixtureConnector } from "../support/fake-chat.ts";

const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
window.localStorage.setItem(MESSAGING_FLAG_KEY, "1");

const demo = seedDemo();
// A draft in the 1-1 chat with Quang Huy, as in mockups/chat.html#app.
window.localStorage.setItem(`chat:draft:${demo.fixture.selfId}:${demo.ids.huy}`, "Chiều nay mình gửi bản sửa");

const container = document.getElementById("root");
if (container === null) throw new Error("harness is missing #root");
createRoot(container).render(
	<StrictMode>
		<App
			transport={createRouterTransport((router) => demo.fixture.routes(router))}
			messagingConnector={fixtureConnector(demo.fixture, openMemoryFactory, demo.data)}
		/>
	</StrictMode>,
);
