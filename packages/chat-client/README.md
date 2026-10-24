# @achoo254/chat-client

Browser client of the [chat-next](https://github.com/achoo254/chat-next) server, in one package. The client
core runs in a module worker per tab: Connect RPC, the realtime WebSocket, the sync engine (gap recovery,
per-chat difference), the outbox with idempotent resend, the media upload queue and cache, and SQLite
(WebAssembly, on OPFS) with full-text search and Vietnamese folding never touch the main thread. One tab per
browser is the leader and holds the database; the other tabs forward their calls to it. The main thread gets an
async `WebChat` with change events batched per animation frame.

There is no default server: you run your own chat backend and pass its origin as `apiOrigin`.

The API is `0.x`: it may change in any minor release until 1.0. Pin the exact version.

| Import | What |
|---|---|
| `@achoo254/chat-client` | `createWebChat`, `goToSignIn`, `submitSignOut`, `requestNotificationPermission`, `WebChat` and its options |
| `@achoo254/chat-client/worker` | The worker entry (load it with your bundler's worker import, see [Vite](#vite)) |
| `@achoo254/chat-client/core` | Types and helpers of the client core: `EventKeys`, `ChatCore`, `SessionEndReason`, `signInUrl`, `realtimeUrlFor`, model types, `startApp` for another platform |
| `@achoo254/chat-client/platform` | The platform interfaces the core runs on (`Platform`, `SqlDriver`, `Socket`, `Timers`, `BlobStore`, ...) |
| `@achoo254/chat-client/proto/<file>` | Protobuf-ES messages and Connect service descriptors of the chat API, one subpath per proto file |

## Install

```sh
npm install @achoo254/chat-client
```

Runtime dependencies: `@connectrpc/connect`, `@connectrpc/connect-web`, `@bufbuild/protobuf` and
`@sqlite.org/sqlite-wasm`. The package is ESM with an `exports` map only: TypeScript needs `moduleResolution`
`bundler`, `node16` or `nodenext`.

pnpm 11 refuses versions published less than 24 hours ago (`minimumReleaseAge`, 1440 minutes by default). To
install a release on its first day, list that exact version in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@achoo254/chat-client@0.1.0"
```

## Same origin: serve the app next to the chat server

The web client signs in with the chat server's session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`), so
the page and the chat server must share one origin. `apiOrigin` is required and must be the page's own origin
(`location.origin`); `createWebChat` throws when it is not. A page on another origin cannot sign in: the
server issues bearer tokens only to its iOS and Android apps.

Put your app and the chat server behind one host with a reverse proxy. The chat server needs these paths:

| Path | What |
|---|---|
| `/rpc/` | Connect RPC (binary and JSON) |
| `/auth/` | Sign-in (`/auth/login`, `/auth/callback`), sign-out (`POST /auth/logout`), back-channel logout |
| `/ws` | Realtime WebSocket (upgrade) |
| `/bot/` | Bot API, only when bots run against this host |
| `/hook/` | Incoming webhooks, only when you use them |

Everything else is your app. With nginx (the chat server listening on `127.0.0.1:4600`, its
`CHAT_PUBLIC_URL` set to `https://chat.example.com`):

```nginx
server {
	listen 443 ssl;
	server_name chat.example.com;
	root /srv/my-chat-app/dist;

	location / {
		try_files $uri /index.html;
	}

	location ~ ^/(rpc|auth|bot|hook)/ {
		proxy_pass http://127.0.0.1:4600;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-Proto https;
	}

	location = /ws {
		proxy_pass http://127.0.0.1:4600;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_read_timeout 75s;
	}
}
```

The chat server trusts `X-Real-IP` only from a loopback peer. The production configuration of chat-next
([`infra/chat/nginx/chat.hoandat.com.conf`](https://github.com/achoo254/chat-next/blob/main/infra/chat/nginx/chat.hoandat.com.conf))
adds rate limits and security headers on top of this.

## Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";

const CHAT_SERVER = "http://127.0.0.1:4600";

export default defineConfig({
	server: {
		// The chat server's CHAT_PUBLIC_URL must be this origin (e.g. http://localhost:5173).
		proxy: {
			"/rpc": CHAT_SERVER,
			"/auth": CHAT_SERVER,
			"/ws": { target: CHAT_SERVER, ws: true },
			// The Bot API and webhooks check the Host header: keep the one the browser sent.
			"/bot/": { target: CHAT_SERVER, changeOrigin: false },
			"/hook/": { target: CHAT_SERVER, changeOrigin: false },
		},
	},
	// The client core runs in a module worker that loads chunks and the SQLite WebAssembly file.
	worker: { format: "es" },
	// sqlite-wasm finds its .wasm file next to its own module; pre-bundling would move it.
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
```

`vite build` emits the worker, the SQLite module and `sqlite3.wasm` as separate assets; `vite preview` uses the
same proxy. No COOP/COEP headers are needed (the `opfs-sahpool` VFS works without `SharedArrayBuffer`). The page
needs a secure context (https, or `localhost` in development) and a browser with OPFS sync access handles.

## Usage

```ts
import { createWebChat, goToSignIn } from "@achoo254/chat-client";
import { EventKeys } from "@achoo254/chat-client/core";
import ChatWorker from "@achoo254/chat-client/worker?worker";

const chat = createWebChat({
	createWorker: () => new ChatWorker(),
	apiOrigin: location.origin, // your chat server, served on this page's origin
	appVersion: "my-app-1.0.0",
	onSessionEnded: (reason) => showSignIn(reason), // "unauthenticated" until the user signs in
});

// Sign in (or sign up) at the chat server's IdP; the browser comes back to "/".
signInButton.onclick = () => goToSignIn("en");

const dialogs = await chat.dialogs(50);
const unsubscribe = chat.events.subscribe(EventKeys.dialogs, () => render(chat));
await chat.sendText(chatId, "Hello");
const page = await chat.history(chatId);
```

Every `ChatCore` method except `close` is available as an async call (`dialogs`, `history`, `sendText`,
`sendMedia`, `markRead`, `search`, ...). `signOutAndLeave()` wipes this browser's data and posts the sign-out
form; `dispose()` stops the client.

### Calling the API directly

For an RPC the client does not wrap, use the generated service descriptors with Connect (same origin as the
page: the server authenticates the web with its session cookie, and every RPC checks the `Origin` header
against its `CHAT_PUBLIC_URL`):

```ts
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { UsersService } from "@achoo254/chat-client/proto/users";

const users = createClient(UsersService, createConnectTransport({ baseUrl: `${location.origin}/rpc` }));
const self = await users.getSelf({});
```

The proto subpaths are `auth`, `bot_admin`, `bots`, `chats`, `config`, `feedback`, `integrations`, `media`,
`messages`, `moderation`, `privacy`, `push`, `realtime`, `search`, `updates`, `users`, generated by
[Protobuf-ES](https://github.com/bufbuild/protobuf-es) v2 from
[`proto/app/v1`](https://github.com/achoo254/chat-next/tree/main/proto/app/v1). 64-bit ids are JavaScript
numbers (`jstype = JS_NUMBER`, always below 2^53).

### Another platform

The core never calls a platform API itself: `startApp(platform, options)` of `@achoo254/chat-client/core`
takes an implementation of `Platform` from `@achoo254/chat-client/platform` (SQL driver, lifecycle, sockets,
timers, notifications, HTTP, blob storage, image probe). The browser implementation behind `createWebChat` is
[`packages/platform-web`](https://github.com/achoo254/chat-next/tree/main/packages/platform-web/src) in the
repository; read it for a complete example.

```ts
import { createConnectTransport } from "@connectrpc/connect-web";
import { createRemoteApi, realtimeUrlFor, startApp } from "@achoo254/chat-client/core";

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

## Server requirements

A running [chat-next server](https://github.com/achoo254/chat-next/tree/main/server) (Go, one binary) with
PostgreSQL 16 and an OpenID Connect provider for sign-in. Its environment, routes and roles are described in
[`server/README.md`](https://github.com/achoo254/chat-next/blob/main/server/README.md). In short:

```sh
cd server && go build -o chat-server ./cmd/server   # Go 1.26
./chat-server -role migrate -env-file chat.env       # apply the database migrations
./chat-server -role api -env-file chat.env           # serve /rpc, /auth, /ws, /bot/v1 on CHAT_LISTEN_ADDR
```

with at least `CHAT_ENV`, `CHAT_PUBLIC_URL` (the origin your users open), `DATABASE_URL`, `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `SESSION_KEY`. The OIDC client's redirect URI is
`<CHAT_PUBLIC_URL>/auth/callback`.

To try the client without an IdP, run the development stack from a checkout of chat-next: a throwaway
PostgreSQL, a fake IdP with test accounts and the real API (development only, never deploy it):

```sh
cd server && go run ./cmd/e2e-stack -public http://localhost:5173
```

## Bots

Bots use the Bot API, not this package: see
[`@achoo254/chat-bot-sdk`](https://www.npmjs.com/package/@achoo254/chat-bot-sdk) (Node).

## License

MIT, see `LICENSE`.
