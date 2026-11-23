// The OTLP receiver's port: fixed per machine, picked once from
// 47300–47399 (outside the ranges Windows reserves for Hyper-V and WSL, and
// below the dynamic range from 49152) and saved in the agent's config. When
// it is taken later the receiver does not move to another port (Claude Code's
// settings name this one): it stays off and status says so.
// tunnels/listen-with-port-fallback.ts does the opposite (it moves on), so
// the listening here is its own.
import { type Server, createServer } from "node:http";

export const OTLP_PORT_MIN = 47300;
export const OTLP_PORT_MAX = 47399;
export const OTLP_HOST = "127.0.0.1";

/** Listens on exactly `port`: "taken" when it is in use or not allowed; other errors reject. */
export function listenOn(server: Server, port: number, host: string = OTLP_HOST): Promise<"listening" | "taken"> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve("taken");
      else reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function portFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    return (await listenOn(probe, port)) === "listening";
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => (probe.listening ? probe.close(() => resolve()) : resolve()));
  }
}

/** The first port of OTLP_PORT_MIN..OTLP_PORT_MAX free now; undefined when none is. */
export async function pickFreePort(isFree: (port: number) => Promise<boolean> = portFree): Promise<number | undefined> {
  for (let port = OTLP_PORT_MIN; port <= OTLP_PORT_MAX; port++) if (await isFree(port)) return port;
  return undefined;
}

/** `port` is one the receiver may use. */
export function isOtlpPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= OTLP_PORT_MIN && port <= OTLP_PORT_MAX;
}
