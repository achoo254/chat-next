import { createRouterTransport } from "@connectrpc/connect";
import { render, type RenderResult } from "@testing-library/react";
import { MemorySqlFactory } from "../../../../packages/core/test/support/node-sql.ts";
import { App } from "../../src/app.tsx";
import { fixtureConnector, type ChatFixture, type FixtureBackendData } from "./fake-chat.ts";

/** Renders the app against the core's in-memory server. */
export function renderMessaging(fixture: ChatFixture, data: FixtureBackendData | undefined, path = "/"): RenderResult {
	window.history.replaceState(null, "", path);
	const transport = createRouterTransport((router) => fixture.routes(router));
	const connector = fixtureConnector(fixture, async () => new MemorySqlFactory(), data);
	return render(<App transport={transport} messagingConnector={connector} />);
}
