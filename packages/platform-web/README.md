# @achoo254/chat-platform-web

Browser client of the [chat-next](https://github.com/achoo254/chat-next) server. The client core
([`@achoo254/chat-core`](https://www.npmjs.com/package/@achoo254/chat-core)) runs in a module worker per tab:
Connect RPC, the realtime WebSocket, the sync engine and SQLite (WebAssembly, on OPFS) never touch the main
thread. One tab per browser is the leader and holds the database; the other tabs forward their calls to it.
The main thread gets an async `WebChat` with change events batched per animation frame.

There is no default server: you run your own chat backend and pass its origin as `apiOrigin`.

The API is `0.x`: it may change in any minor release until 1.0. Pin the exact version.

## Install

```sh
npm install @achoo254/chat-platform-web @achoo254/chat-core
```

`@achoo254/chat-core` is only needed when you import from it directly (types such as `SessionEndReason`,
helpers such as `signInUrl`); `@achoo254/chat-platform-web` already depends on it.

pnpm 11 refuses versions published less than 24 hours ago (`minimumReleaseAge`, 1440 minutes by default). To
install a release on its first day, list those exact versions in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@achoo254/chat-platform-web@0.1.0"
  - "@achoo254/chat-core@0.1.0"
  - "@achoo254/chat-platform@0.1.0"
  - "@achoo254/chat-proto@0.1.0"
```

## Same origin: serve the app next to the chat server

The web client signs in with the chat server's session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`), so
the page and the chat server must share one origin. `apiOrigin` must be the page's own origin
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
import { EventKeys } from "@achoo254/chat-core";
import { createWebChat, goToSignIn } from "@achoo254/chat-platform-web";
import ChatWorker from "@achoo254/chat-platform-web/worker?worker";

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

Every `ChatCore` method of `@achoo254/chat-core` is available as an async call (`dialogs`, `history`,
`sendText`, `sendMedia`, `markRead`, `search`, ...). `signOutAndLeave()` wipes this browser's data and posts the
sign-out form; `dispose()` stops the client.

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

## License

MIT, see `LICENSE`.
