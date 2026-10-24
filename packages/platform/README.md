# @achoo254/chat-platform

The platform seam of [`@achoo254/chat-core`](https://www.npmjs.com/package/@achoo254/chat-core): TypeScript
interfaces for what the client core needs from its host (SQL driver, lifecycle, WebSocket, timers, frame
scheduler, notifications, HTTP, blob storage, image probe) plus two small implementations (`systemTimers`,
`cryptoRandomId`). A platform package implements them and passes them to `startApp`; the browser one is
[`@achoo254/chat-platform-web`](https://www.npmjs.com/package/@achoo254/chat-platform-web).

No runtime dependencies.

The API is `0.x`: it may change in any minor release until 1.0. Pin the exact version.

## Install

```sh
npm install @achoo254/chat-platform
```

pnpm 11 refuses versions published less than 24 hours ago (`minimumReleaseAge`, 1440 minutes by default). To
install a release on its first day, list that exact version in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@achoo254/chat-platform@0.1.0"
```

## Usage

```ts
import { cryptoRandomId, systemTimers, type Platform, type SqlDriver } from "@achoo254/chat-platform";
```

## Server requirements

There is no default server: you run your own [chat-next server](https://github.com/achoo254/chat-next/tree/main/server)
(Go, PostgreSQL 16, an OpenID Connect provider) and point the client at it. Environment, routes and roles:
[`server/README.md`](https://github.com/achoo254/chat-next/blob/main/server/README.md); how a web page reaches it
(same origin, reverse proxy): [`@achoo254/chat-platform-web`](https://www.npmjs.com/package/@achoo254/chat-platform-web).

## License

MIT, see `LICENSE`.
