// The server name of tunelo's MCP in an AI session, on its own so that code
// naming tunelo's tools does not load the MCP server.

/** The server name of tunelo's MCP in an AI session. */
export const SESSION_MCP_SERVER = "tunelo";

/**
 * The server name of tunelo's MCP in the AI's own CLI opened in a terminal
 * (advisor_weigh only): not "tunelo", which the user may have added to the
 * CLI themselves (`claude mcp add tunelo -- tunelo mcp`), so neither hides
 * the other.
 */
export const TERMINAL_ADVISOR_MCP_SERVER = "tunelo-advisor";
