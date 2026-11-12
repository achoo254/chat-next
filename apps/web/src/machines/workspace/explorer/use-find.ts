// "Find files" of the Explorer. Names: the machine lists the paths holding
// every word typed (WsFindNames, debounced); while the user keeps typing
// onto a query whose list was complete, the list is narrowed here instead
// of asking again. Contents: lines that hold the text (WsFindContents,
// git grep on the machine), with match case, whole word and regex options.
import { useEffect, useState } from "react";
import type { WsFindContentsResult } from "@achoo254/chat-proto/remote/remote";
import { ask, type WsLink } from "../ws-client.ts";

export type FindMode = "names" | "contents";

export interface ContentOptions {
	readonly caseSensitive: boolean;
	readonly wholeWord: boolean;
	readonly regex: boolean;
}

type Names = { readonly kind: "names"; readonly query: string; readonly paths: readonly string[]; readonly truncated: boolean };

export type FindResult =
	| { readonly kind: "idle" }
	| { readonly kind: "searching" }
	| Names
	| { readonly kind: "contents"; readonly result: WsFindContentsResult }
	| { readonly kind: "error"; readonly error: unknown };

const NAMES_DELAY_MS = 150;
const CONTENTS_DELAY_MS = 350;
const NAMES_LIMIT = 500;

/** The query's words, lower case. */
function words(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w !== "");
}

/** Paths holding every word of `query` (as the machine matches them). */
export function filterNames(paths: readonly string[], query: string): string[] {
	const want = words(query);
	return paths.filter((path) => {
		const lower = path.toLowerCase();
		return want.every((w) => lower.includes(w));
	});
}

/**
 * The complete list for `previous` narrows to `next` here: typing onto the
 * end of a query only adds letters to its last word or adds words, so every
 * path matching `next` also matched `previous`.
 */
export function narrows(previous: Names | null, next: string): boolean {
	if (previous === null || previous.truncated) return false;
	const before = previous.query.trim().toLowerCase();
	return before !== "" && next.trim().toLowerCase().startsWith(before);
}

export function useFind(link: WsLink, workspaceId: string, mode: FindMode, query: string, options: ContentOptions): FindResult {
	const { caseSensitive, wholeWord, regex } = options;
	const trimmed = query.trim();
	const key = `${workspaceId}\u0000${mode}\u0000${trimmed}\u0000${caseSensitive}\u0000${wholeWord}\u0000${regex}`;
	/** The answer to the newest search sent, with the key it answers. */
	const [answer, setAnswer] = useState<{ key: string; value: FindResult } | null>(null);
	/** The last list of names the machine sent, kept to narrow while typing on. */
	const [names, setNames] = useState<Names | null>(null);
	const local = mode === "names" && narrows(names, trimmed);
	useEffect(() => {
		if (trimmed === "" || local) return;
		let live = true;
		const done = (value: FindResult) => {
			if (live) setAnswer({ key, value });
		};
		const timer = setTimeout(
			() => {
				if (mode === "names") {
					ask(link, { case: "wsFindNames", value: { workspaceId, query: trimmed, limit: NAMES_LIMIT } }, "wsFindNamesResult").then(
						(r) => {
							const found: Names = { kind: "names", query: trimmed, paths: r.paths, truncated: r.truncated };
							if (live) setNames(found);
							done(found);
						},
						(error: unknown) => done({ kind: "error", error }),
					);
				} else {
					ask(link, { case: "wsFindContents", value: { workspaceId, query: trimmed, caseSensitive, wholeWord, regex } }, "wsFindContentsResult").then(
						(r) => done({ kind: "contents", result: r }),
						(error: unknown) => done({ kind: "error", error }),
					);
				}
			},
			mode === "names" ? NAMES_DELAY_MS : CONTENTS_DELAY_MS,
		);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [link, workspaceId, mode, trimmed, caseSensitive, wholeWord, regex, key, local]);
	if (trimmed === "") return { kind: "idle" };
	if (local && names !== null) return { kind: "names", query: trimmed, paths: filterNames(names.paths, trimmed), truncated: false };
	return answer !== null && answer.key === key ? answer.value : { kind: "searching" };
}
