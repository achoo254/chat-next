// Whether the server refused a reaction because the chat's synced app does not take the emoji.
//
// Its own module, apart from the emoji lists of bridge-reactions.ts, because the message bubble
// (message-item.tsx, on the startup path) needs only this check while the pickers that use the lists
// load lazily. It reads the refusal by its shape instead of importing @connectrpc/connect:
// ConnectError.from would pull the Connect and protobuf runtime (about 7.7 KB gzip) into the startup
// bundle (test/perf/budgets.ts).

/** Code.InvalidArgument of @connectrpc/connect (gRPC status 3). */
const INVALID_ARGUMENT = 3;

/** True when the server refused a reaction because the synced app does not take the emoji. */
export function isReactionRefused(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code: unknown = "code" in err ? err.code : undefined;
	const rawMessage: unknown = "rawMessage" in err ? err.rawMessage : undefined;
	return code === INVALID_ARGUMENT && typeof rawMessage === "string" && rawMessage.startsWith("reaction_not_accepted");
}
