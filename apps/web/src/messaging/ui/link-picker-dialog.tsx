// "Nối với…" (ADR 0025): links the other person of a private chat with
// another user the caller has a private chat with, the same person on
// another app. Candidates are the caller's other private-chat peers (not
// themselves, not bots, not already in this person); the search matches
// names without accents. Only the caller sees the link.
import { fold } from "@achoo254/chat-core";
import { useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useListEntries, useServices, useUserNames } from "../data/services.tsx";
import type { PeopleStore } from "../people/people-store.ts";
import { appLabel, peopleFailure } from "./link-suggestions.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";

const collator = new Intl.Collator("vi", { sensitivity: "base" });

interface Candidate {
	readonly userId: number;
	readonly app: string;
}

/** The peers of the caller's private chats, without those in `exclude`, bots and the caller. */
function useCandidates(exclude: ReadonlySet<number>): readonly Candidate[] {
	const { store } = useServices();
	const entries = useListEntries();
	const seen = new Set<number>();
	const candidates: Candidate[] = [];
	for (const entry of entries) {
		if (entry.kind !== "private" || entry.saved) continue;
		const userId = store.chat(entry.chatId)?.peerUserId ?? 0;
		if (userId === 0 || userId === store.selfId || exclude.has(userId) || seen.has(userId)) continue;
		if (store.user(userId)?.isBot === true) continue;
		seen.add(userId);
		candidates.push({ userId, app: entry.app });
	}
	return candidates;
}

interface LinkPickerProps {
	store: PeopleStore;
	/** The user to link, and their name for the intro. */
	userId: number;
	name: string;
	/** Users already in the same person as `userId` (offered no more). */
	linked: ReadonlySet<number>;
	onClose: () => void;
}

export function LinkPickerDialog({ store, userId, name, linked, onClose }: LinkPickerProps) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const id = useDomId("link-picker");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(0);
	const [failure, setFailure] = useState("");
	const t = copy.people;
	const candidates = useCandidates(new Set([userId, ...linked]));
	const names = useUserNames(candidates.map((candidate) => candidate.userId));
	const needle = fold(query.trim());
	const nameOf = (candidate: Candidate): string => names.get(candidate.userId) ?? "";
	const shown = candidates
		.filter((candidate) => needle === "" || fold(nameOf(candidate)).includes(needle))
		.sort((a, b) => collator.compare(nameOf(a), nameOf(b)) || a.userId - b.userId);

	const pick = (candidate: Candidate, candidateName: string) => {
		setBusy(candidate.userId);
		setFailure("");
		store.link([userId, candidate.userId]).then(
			() => {
				toasts.show(t.linked(candidateName));
				onClose();
			},
			(err: unknown) => {
				setBusy(0);
				setFailure(peopleFailure(err, copy));
			},
		);
	};

	return (
		<Modal labelledBy={id} onClose={onClose} className="link-picker">
			<DialogHead id={id} title={t.pickTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="link" />
					<span>{t.pickIntro(name)}</span>
				</p>
				{candidates.length === 0 ? (
					<p className="note">{t.pickEmpty}</p>
				) : (
					<>
						<label className="search-field">
							<Icon name="search" small />
							<span className="sr-only">{t.pickSearch}</span>
							<input type="search" placeholder={t.pickSearch} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
						</label>
						{failure !== "" && (
							<div className="banner error" role="alert">
								<Icon name="alert" small />
								<span className="grow">{failure}</span>
							</div>
						)}
						{shown.length === 0 ? (
							<p className="note">{t.pickNoMatch}</p>
						) : (
							<ul className="result-list pick-list" aria-label={t.pickTitle}>
								{shown.map((candidate) => {
									const candidateName = nameOf(candidate);
									return (
										<li key={candidate.userId}>
											<button
												type="button"
												className="result pick-row"
												aria-busy={busy === candidate.userId}
												disabled={busy !== 0}
												onClick={() => pick(candidate, candidateName)}
											>
												<ChatAvatar id={candidate.userId} name={candidateName} photoOf={candidate.userId} />
												<b>{candidateName}</b>
												<span className="tag grey">{appLabel(candidate.app, copy)}</span>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
