import type { CallToolResult } from "@modelcontextprotocol/server";

export function ok(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function failure(err: unknown): CallToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { isError: true, content: [{ type: "text", text: message }] };
}

/** Runs a tool body: its value as JSON text, or its error as a tool error. */
export async function attempt(
	run: () => Promise<unknown>,
): Promise<CallToolResult> {
	try {
		return ok(await run());
	} catch (err) {
		return failure(err);
	}
}
