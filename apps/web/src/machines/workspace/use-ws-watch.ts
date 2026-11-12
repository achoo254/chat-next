// Watching the workspace while the panel shows: WsWatch on when it opens
// (and again after the link comes back: the machine stops watching for a
// closed connection), off when it closes. Each WsChanged goes to the
// panel's parts that registered for it; "polling" says the machine looks at
// git's status every 10 s instead of watching files.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WsChanged } from "@achoo254/chat-proto/remote/remote";
import { onWsChanged, type WsLink } from "./ws-client.ts";

export interface Watch {
	readonly polling: boolean;
	/** Adds a listener of the workspace's changes; returns the remove. */
	readonly subscribe: (listener: (change: WsChanged) => void) => () => void;
}

export function useWsWatch(link: WsLink, workspaceId: string, online: boolean): Watch {
	const [polling, setPolling] = useState(false);
	const listeners = useRef(new Set<(change: WsChanged) => void>());
	useEffect(
		() =>
			onWsChanged(link, workspaceId, (change) => {
				if (change.polling) setPolling(true);
				for (const listener of listeners.current) listener(change);
			}),
		[link, workspaceId],
	);
	useEffect(() => {
		if (!online) return;
		// An older machine does not know WsWatch: the panel says so through its first read.
		link.request({ case: "wsWatch", value: { workspaceId, on: true } }).catch(() => undefined);
		return () => {
			link.request({ case: "wsWatch", value: { workspaceId, on: false } }).catch(() => undefined);
		};
	}, [link, workspaceId, online]);
	const subscribe = useCallback((listener: (change: WsChanged) => void) => {
		const set = listeners.current;
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}, []);
	return { polling, subscribe };
}
