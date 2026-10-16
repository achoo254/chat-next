// Loads a screen's data once per key, with a retry.
import { useEffect, useEffectEvent, useState } from "react";

export type Loaded<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

export function useLoad<T>(load: () => Promise<T>, key: string): [Loaded<T>, () => void] {
	const [state, setState] = useState<Loaded<T> & { key: string }>({ status: "loading", key });
	const [attempt, setAttempt] = useState(0);
	// `load` is recreated per render; `key` identifies what it loads.
	const run = useEffectEvent(load);
	useEffect(() => {
		let active = true;
		run().then(
			(value) => {
				if (active) setState({ status: "ready", value, key });
			},
			() => {
				if (active) setState({ status: "error", key });
			},
		);
		return () => {
			active = false;
		};
	}, [key, attempt]);
	return [state.key === key ? state : { status: "loading" }, () => setAttempt((n) => n + 1)];
}

