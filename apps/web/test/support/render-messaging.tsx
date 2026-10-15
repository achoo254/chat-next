import { render, type RenderResult } from "@testing-library/react";
import { MemorySqlFactory } from "../../../../packages/core/test/support/node-sql.ts";
import { App } from "../../src/app.tsx";
import { fixtureConnector, type ChatFixture } from "./fake-chat.ts";
import { routerFetch } from "./router-fetch.ts";

/**
 * Renders the app against the core's in-memory server. Pass `sql` to start
 * again on the device database of an earlier render.
 */
export function renderMessaging(fixture: ChatFixture, path = "/", sql = new MemorySqlFactory()): RenderResult {
	window.history.replaceState(null, "", path);
	const rpcFetch = routerFetch((router) => fixture.routes(router));
	const connector = fixtureConnector(fixture, async () => sql);
	return render(<App rpcFetch={rpcFetch} messagingConnector={connector} />);
}
