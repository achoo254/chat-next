// An in-memory server for <App rpcFetch>: the Connect routes of a test
// served behind a fetch function, so the app's requests (binary through the
// Connect transport, JSON for GetSelf) cross the same encoding as with the
// real server. Never imported by production code.
import { createConnectRouter, type ConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";

const RPC_PREFIX = "/rpc";

export function routerFetch(routes: (router: ConnectRouter) => void): typeof globalThis.fetch {
	const router = createConnectRouter();
	routes(router);
	const handlers = new Map(router.handlers.map((handler) => [`${RPC_PREFIX}${handler.requestPath}`, createFetchHandler(handler)]));
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const request = new Request(new URL(url, "http://localhost"), init);
		const handler = handlers.get(new URL(request.url).pathname);
		if (handler === undefined) return new Response(null, { status: 404 });
		return handler(request);
	};
}
