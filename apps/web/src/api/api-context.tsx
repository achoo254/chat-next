import { createContext, useContext } from "react";
import type { Api } from "./client.ts";

// The Api object is created once per app and never changes, so a context is fine here.
export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
	const api = useContext(ApiContext);
	if (!api) throw new Error("useApi must be used inside <ApiContext>");
	return api;
}
