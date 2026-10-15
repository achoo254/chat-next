import { render, type RenderResult } from "@testing-library/react";
import { MemorySqlFactory } from "../../../../packages/core/test/support/node-sql.ts";
import { App } from "../../src/app.tsx";
import { fixtureConnector, type ChatFixture } from "./fake-chat.ts";
import { routerFetch } from "./router-fetch.ts";

/** Renders the app against the core's in-memory server. */
export function renderMessaging(fixture: ChatFixture, path = "/"): RenderResult {
	window.history.replaceState(null, "", path);
	const rpcFetch = routerFetch((router) => fixture.routes(router));
	const connector = fixtureConnector(fixture, async () => new MemorySqlFactory());
	return render(<App rpcFetch={rpcFetch} messagingConnector={connector} />);
}
