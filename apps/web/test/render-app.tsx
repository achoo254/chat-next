import type { ConnectRouter } from "@connectrpc/connect";
import { render, type RenderResult } from "@testing-library/react";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { App } from "../src/app.tsx";
import { ChatFixture, fixtureConnector } from "./support/fake-chat.ts";
import { routerFetch } from "./support/router-fetch.ts";

/**
 * Renders the app against an in-memory Connect server built from `routes`
 * (account services). Chats come from an empty in-memory chat server.
 */
export function renderApp(routes: (router: ConnectRouter) => void, path = "/"): RenderResult {
	window.history.replaceState(null, "", path);
	const fixture = new ChatFixture();
	const rpcFetch = routerFetch((router) => {
		routes(router);
		fixture.chatRoutes(router);
	});
	const connector = fixtureConnector(fixture, async () => new MemorySqlFactory());
	return render(<App rpcFetch={rpcFetch} messagingConnector={connector} />);
}
export const SELF = {
	id: 42n,
	name: "Đức Thắng",
	username: "thang_dt",
	bio: "Kỹ sư vận hành.",
	email: "thang@example.com",
	isSelf: true,
};
