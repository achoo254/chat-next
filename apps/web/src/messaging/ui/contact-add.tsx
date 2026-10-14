// Adding a contact (mockups/chat.html#contact-add): an exact username (with
// or without @) or a full email. Results follow the other person's "find me
// by username/email" settings, so someone who hides shows the same "Không
// tìm thấy" as no account at all. Email never shows in results.
import { Code, ConnectError } from "@connectrpc/connect";
import { useState, type ReactNode } from "react";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { contactsOf, useContacts } from "../data/contacts.ts";
import type { ContactTarget, Person } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";
import { usePeopleSearch } from "./people-search.ts";

/** Asks for the person the way the user looked them up (the server checks that kind of search). */
function targetFor(person: Person, query: string, byEmail: boolean): ContactTarget {
	if (byEmail) return { email: query };
	return person.username !== "" ? { username: person.username } : { userId: person.id };
}

export function AddContactDialog({ onClose }: { onClose: () => void }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const contacts = useContacts(remote);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(0);
	const { people, failed } = usePeopleSearch(query);
	const id = useDomId("add-contact");
	const t = copy.contacts;
	const clean = query.trim();
	const byEmail = clean.includes("@") && !clean.startsWith("@");

	const add = (person: Person) => {
		setBusy(person.id);
		contactsOf(remote)
			.add(targetFor(person, clean, byEmail))
			.then(
				(added) => toasts.show(t.added(added.name)),
				(err: unknown) => {
					const code = ConnectError.from(err).code;
					toasts.show(code === Code.NotFound ? t.notFoundTitle : code === Code.FailedPrecondition ? t.full : copy.common.failed);
				},
			)
			.finally(() => setBusy(0));
	};

	let results: ReactNode = null;
	if (failed) {
		results = <p className="note">{copy.common.loadFailed}</p>;
	} else if (people !== null && people.length === 0) {
		results = (
			<div className="empty compact">
				<Icon name="user" />
				<strong>{t.notFoundTitle}</strong>
				<span>{t.notFoundBody}</span>
			</div>
		);
	} else if (people !== null) {
		results = (
			<div className="result-list">
				{people.map((person) => (
					<div className="result" key={person.id}>
						<ChatAvatar id={person.id} name={person.name} bot={person.isBot} />
						<span>
							<b>{person.name}</b>
							{person.username !== "" && <small>@{person.username}</small>}
							<span className="match">
								<Icon name="check" />
								{byEmail ? t.matchEmail : t.matchUsername}
							</span>
						</span>
						{contacts.ids.has(person.id) ? (
							<span className="tag ok">{t.already}</span>
						) : (
							<button
								type="button"
								className="btn btn-primary btn-compact"
								aria-busy={busy === person.id}
								disabled={busy !== 0 || contacts.status !== "ready"}
								onClick={() => add(person)}
							>
								<Icon name="user-plus" />
								{t.addTo}
							</button>
						)}
					</div>
				))}
			</div>
		);
	}

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead
				id={id}
				title={t.addTitle}
				backLabel={t.backToContacts}
				onBack={() => {
					onClose();
					navigate(paths.contacts());
				}}
				onClose={onClose}
			/>
			<div className="dlg-body stack">
				<div className="field">
					<label htmlFor={`${id}-q`}>{t.addLabel}</label>
					<span className="search-field">
						<Icon name="search" small />
						<input
							id={`${id}-q`}
							type="search"
							placeholder={t.addPlaceholder}
							autoComplete="off"
							spellCheck={false}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</span>
				</div>
				<div aria-live="polite">{results}</div>
				<p className="note">
					<Icon name="shield" />
					<span>{t.addNote}</span>
				</p>
			</div>
		</Modal>
	);
}
