// Variables tunelo removes from its own environment as it starts, so the
// processes it runs (the background service, claude sessions and their MCP
// servers) never inherit them.

/**
 * Set by the npm package `tunelo` 1.12 on the 2.x process it hands a
 * command to, so 2.x never hands it back. Passed on, it would make a
 * `tunelo` 1.12 run later by a child (`tunelo mcp` in a claude session)
 * stop forwarding and fail.
 */
export const NPM_FORWARD_ENV = "TUNELO_FROM_NPM_1X";

export function dropInheritedMarkers(env: NodeJS.ProcessEnv = process.env): void {
  Reflect.deleteProperty(env, NPM_FORWARD_ENV);
}
