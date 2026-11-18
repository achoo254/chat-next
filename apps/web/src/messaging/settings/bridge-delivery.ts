// Which chats send on to another app (Chat Bridge, ADR 0022), for the parts of
// the messaging UI that cannot know it from the chat itself. The answer comes
// from the bridge status, kept for a minute and dropped whenever the settings
// page changes a chat's direction. Loaded on demand: a server without the
// bridge, or a chat that is not connected, costs one call a minute at most.
import type { Transport } from "@connectrpc/connect";
import { bridgeClient } from "./bridge-client.ts";

const STATUS_TTL_MS = 60_000;

let cache: { readonly transport: Transport; readonly at: number; readonly both: Promise<ReadonlyMap<number, string>> } | null = null;

/** Forgets the cached status: the next question asks the server. */
export function forgetBridgeStatus(): void {
	cache = null;
}

/** The chats that send what is written in them on to another app, with the app's id ("telegram"); empty when the bridge is off or the call fails. */
export function twoWayChats(transport: Transport): Promise<ReadonlyMap<number, string>> {
	if (cache !== null && cache.transport === transport && Date.now() - cache.at < STATUS_TTL_MS) return cache.both;
	const both = bridgeClient(transport)
		.status()
		.then(
			(status) =>
				new Map(
					status.accounts
						.filter((a) => a.status === "active")
						.flatMap((a) => a.chats.filter((c) => c.direction === "both").map((c): [number, string] => [c.chatId, a.source])),
				),
			() => new Map<number, string>(),
		);
	cache = { transport, at: Date.now(), both };
	return both;
}

export { bridgeClient };
