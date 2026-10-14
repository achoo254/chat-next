// People search on the server (SearchUsers), debounced, shared by the new
// chat, member picker and add contact dialogs. Results respect each user's
// "find me by username/email" setting on the server.
import { useEffect, useState } from "react";
import type { Person } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";

const SEARCH_DELAY_MS = 250;

/** Matches for `query` ("@" optional); null while typing, loading or when the query is empty. */
export function usePeopleSearch(query: string): { people: Person[] | null; failed: boolean } {
	const { remote } = useServices();
	const [result, setResult] = useState<{ query: string; people: Person[]; failed: boolean } | null>(null);
	const clean = query.trim().replace(/^@/, "");
	useEffect(() => {
		if (clean === "") return;
		let active = true;
		const timer = setTimeout(() => {
			remote.searchPeople(clean).then(
				(people) => {
					if (active) setResult({ query: clean, people, failed: false });
				},
				() => {
					if (active) setResult({ query: clean, people: [], failed: true });
				},
			);
		}, SEARCH_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [remote, clean]);
	if (clean === "" || result === null || result.query !== clean) return { people: null, failed: false };
	return { people: result.people, failed: result.failed };
}
