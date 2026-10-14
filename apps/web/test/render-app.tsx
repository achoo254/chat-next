import { createRouterTransport, type ConnectRouter } from "@connectrpc/connect";
import { render, type RenderResult } from "@testing-library/react";
import { App } from "../src/app.tsx";

/** Renders the app against an in-memory Connect server built from `routes`. */
export function renderApp(routes: (router: ConnectRouter) => void, path = "/"): RenderResult {
	window.history.replaceState(null, "", path);
	return render(<App transport={createRouterTransport(routes)} />);
}

export const SELF = {
	id: 42n,
	name: "Đức Thắng",
	username: "thang_dt",
	bio: "Kỹ sư vận hành.",
	email: "thang@example.com",
	isSelf: true,
};
