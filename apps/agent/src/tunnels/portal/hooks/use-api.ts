/** Generic data-fetching hook with loading / error state */

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api/client.js";

export interface UseApiState<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	refetch: () => void;
}

/** Fetch `path` on mount and whenever `deps` change */
export function useApi<T>(path: string, deps: unknown[] = []): UseApiState<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetch = useCallback(async () => {
		setLoading(true);
		setError(null);
		const res = await apiFetch<T>(path);
		if (res.ok) {
			setData(res.data);
		} else {
			setError(res.error);
		}
		setLoading(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path, ...deps]);

	useEffect(() => {
		void fetch();
	}, [fetch]);

	return { data, loading, error, refetch: fetch };
}
