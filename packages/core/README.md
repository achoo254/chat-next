# @achoo254/chat-core

Platform-agnostic client core of the [chat-next](https://github.com/achoo254/chat-next) server: Connect RPC
transport, realtime WebSocket, sync engine (gap recovery, per-chat difference), outbox with idempotent resend,
media upload queue and cache, local SQLite schema and full-text search with Vietnamese folding, and the
cold-start snapshot. It never calls a platform API itself: a platform package hands it a SQL driver, sockets,
timers and storage through [`@achoo254/chat-platform`](https://www.npmjs.com/package/@achoo254/chat-platform).

For a web app use [`@achoo254/chat-platform-web`](https://www.npmjs.com/package/@achoo254/chat-platform-web),
which runs this core in a worker and gives the page an async client; import from `@achoo254/chat-core` for its
types, `EventKeys` and helpers.

The API is `0.x`: it may change in any minor release until 1.0. Pin the exact version.

## Install

```sh
npm install @achoo254/chat-core
```

pnpm 11 refuses versions published less than 24 hours ago (`minimumReleaseAge`, 1440 minutes by default). To
install a release on its first day, list that exact version in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@achoo254/chat-core@0.1.0"
  - "@achoo254/chat-platform@0.1.0"
  - "@achoo254/chat-proto@0.1.0"
```

## Usage

`startApp(platform, options)` is the entry point of a platform implementation (this example also needs
`@connectrpc/connect-web` for the browser transport):

```ts
import { createConnectTransport } from "@connectrpc/connect-web";
import { createRemoteApi, realtimeUrlFor, startApp } from "@achoo254/chat-core";

const apiOrigin = "https://chat.example.com"; // your chat server
const result = await startApp(platform, {
	api: createRemoteApi(createConnectTransport({ baseUrl: `${apiOrigin}/rpc`, useBinaryFormat: true })),
	realtimeUrl: realtimeUrlFor(apiOrigin), // wss://chat.example.com/ws
	appVersion: "my-app-1.0.0",
	client: "web",
	tenant: new URL(apiOrigin).host, // part of the local database name
});
if (result.status === "active") {
	const dialogs = await result.core.dialogs(50);
}
```

`platform` implements `Platform` of `@achoo254/chat-platform`. The web implementation (worker, OPFS SQLite,
leader tab, Cache API blobs) is `@achoo254/chat-platform-web`; read its source for a complete example.

## Server requirements

There is no default server: you run your own [chat-next server](https://github.com/achoo254/chat-next/tree/main/server)
(Go, PostgreSQL 16, an OpenID Connect provider) and point the client at it. Environment, routes and roles:
[`server/README.md`](https://github.com/achoo254/chat-next/blob/main/server/README.md); how a web page reaches it
(same origin, reverse proxy): [`@achoo254/chat-platform-web`](https://www.npmjs.com/package/@achoo254/chat-platform-web).

## License

MIT, see `LICENSE`.
