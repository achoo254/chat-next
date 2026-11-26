// The names of a usage report's sessions on this device: the machine's list
// of an AI's transcripts (SessionList) gives each session's title and the
// thread that holds it, if any. The report itself carries no title (it never
// leaves the machine in a report), so the page asks once per AI it names.
// Unknown sessions keep their short id; a machine that cannot list sessions
// leaves every name unknown.
import type { UsageReport } from "@achoo254/chat-proto/remote/remote";
import { useEffect, useState } from "react";
import { ask, type WsLink } from "../workspace/ws-client.ts";

export interface SessionName {
	readonly title: string;
	/** The thread that holds the session; "" for none (opened outside the app). */
	readonly threadId: string;
}

/** Transcripts asked per AI: the report lists at most 50 sessions, mostly recent. */
const LIST_LIMIT = 100;

export function useSessionNames(link: WsLink, report: UsageReport | null, online: boolean): ReadonlyMap<string, SessionName> {
	const [names, setNames] = useState<ReadonlyMap<string, SessionName>>(new Map());
	const providers = report === null ? "" : [...new Set(report.sessions.map((s) => s.provider))].sort().join("\u0000");
	useEffect(() => {
		if (!online || providers === "") return;
		let live = true;
		Promise.all(
			providers.split("\u0000").map((provider) =>
				ask(link, { case: "sessionList", value: { provider, dir: "", limit: LIST_LIMIT } }, "sessionListResult").then(
					(r) => r.sessions,
					() => [],
				),
			),
		).then((lists) => {
			if (!live) return;
			const next = new Map<string, SessionName>();
			for (const s of lists.flat()) next.set(s.sessionId, { title: s.title, threadId: s.threadId });
			setNames(next);
		});
		return () => {
			live = false;
		};
	}, [link, online, providers]);
	return names;
}
