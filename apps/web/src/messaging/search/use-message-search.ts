// The message search of a screen: a core SearchSession (local hits at once,
// the server's merged in after a pause in typing) bound to React state. The
// session asks the server only while the device is online, and asks again
// on its own once the connection comes back.
import { IDLE_SEARCH, SearchSession, type SearchRequest, type SearchState } from "@achoo254/chat-core";
import { useEffect, useState } from "react";
import { useConnection, useServices } from "../data/services.tsx";

export interface MessageSearch {
	readonly state: SearchState;
	/** Loads the next page of server hits. */
	more(): void;
	/** Asks the server again after a failure. */
	retry(): void;
}

const timers = {
	setTimeout: (callback: () => void, ms: number): unknown => window.setTimeout(callback, ms),
	clearTimeout: (handle: unknown): void => {
		if (typeof handle === "number") window.clearTimeout(handle);
	},
};

export function useMessageSearch(request: SearchRequest): MessageSearch {
	const { source } = useServices();
	const connection = useConnection();
	const [state, setState] = useState<SearchState>(IDLE_SEARCH);
	const [session] = useState(
		() =>
			new SearchSession({
				local: (text, options) => source.search(text, options),
				server: (serverRequest) => source.searchServer(serverRequest),
				timers,
				onChange: setState,
			}),
	);
	useEffect(() => () => session.dispose(), [session]);

	// Before the request effect, so the first search already knows.
	const online = connection !== "offline";
	useEffect(() => {
		session.setOnline(online);
	}, [session, online]);

	const key = JSON.stringify(request);
	useEffect(() => {
		session.set(JSON.parse(key) as SearchRequest);
	}, [session, key]);

	return { state, more: () => session.more(), retry: () => session.retry() };
}
