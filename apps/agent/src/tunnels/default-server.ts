/**
 * The Tunelo server of the primary domain, used when nothing else names
 * one (no `--server`, `TUNELO_SERVER` or saved config). Shared by the CLI
 * and the local portal; no imports, so the browser bundle can take it.
 */
export const DEFAULT_SERVER_URL = "https://tunnel.hoandat.com";
