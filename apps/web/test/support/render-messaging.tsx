import { createRouterTransport } from "@connectrpc/connect";
import { render, type RenderResult } from "@testing-library/react";
import { MemorySqlFactory } from "../../../../packages/core/test/support/node-sql.ts";
import { App } from "../../src/app.tsx";
import { MESSAGING_FLAG_KEY } from "../../src/features.ts";
import { fixtureConnector, type ChatFixture, type FixtureBackendData } from "./fake-chat.ts";

/** Renders the app with messaging on, against the core's in-memory server. */
export function renderMessaging(fixture: ChatFixture, data: FixtureBackendData | undefined, path = "/"): RenderResult {
	window.localStorage.setItem(MESSAGING_FLAG_KEY, "1");
	window.history.replaceState(null, "", path);
	const transport = createRouterTransport((router) => fixture.routes(router));
	const connector = fixtureConnector(fixture, async () => new MemorySqlFactory(), data);
	return render(<App transport={transport} messagingConnector={connector} />);
}
