// "Cùng một người" in the info column of a private chat (ADR 0025): the
// identities linked with this chat's person (their app and current name,
// the one of this chat marked in words), each with "Bỏ nối"; the
// suggestions for this user; and "Nối với…" to pick another private chat.
// With nothing linked or suggested only "Nối với…" shows. A linked person
// also offers their merged timeline (people/person-screen.tsx).
import { useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { navigate } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import type { PersonMember } from "../people/people-api.ts";
import { personOf, usePeople, type PeopleStore } from "../people/people-store.ts";
import { personPath } from "../people/person-path.ts";
import { LinkPickerDialog } from "./link-picker-dialog.tsx";
import { IdentityName, UserLinkSuggestions, identityLabel, peopleFailure } from "./link-suggestions.tsx";

function IdentityRow({ store, member, current }: { store: PeopleStore; member: PersonMember; current: boolean }) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const [busy, setBusy] = useState(false);
	const t = copy.people;
	const unlink = () => {
		setBusy(true);
		store
			.unlink(member.userId)
			.then(
				() => toasts.show(t.unlinked(member.name)),
				(err: unknown) => toasts.show(peopleFailure(err, copy)),
			)
			.finally(() => setBusy(false));
	};
	return (
		<li className="row identity-row">
			<span className="grow">
				<IdentityName member={member} />
				{current && <small>{t.thisChat}</small>}
			</span>
			<button type="button" className="btn btn-sm" aria-label={t.unlinkLabel(identityLabel(member, copy))} aria-busy={busy} disabled={busy} onClick={unlink}>
				{t.unlink}
			</button>
		</li>
	);
}

export function PeopleSection({ userId, name }: { userId: number; name: string }) {
	const copy = useScreensCopy();
	const [store, people] = usePeople(userId);
	const [picking, setPicking] = useState(false);
	const t = copy.people;
	if (people.status === "unsupported") return null;
	const person = personOf(people.people, userId);
	const suggestions = people.suggestions.get(userId) ?? [];
	const linked = new Set(person?.members.map((member) => member.userId) ?? []);
	return (
		<div className="info-sec people-sec">
			{(person !== undefined || suggestions.length > 0) && <h3>{t.title}</h3>}
			{person !== undefined && (
				<ul className="identities-list" aria-label={t.title}>
					{person.members.map((member) => (
						<IdentityRow key={member.userId} store={store} member={member} current={member.userId === userId} />
					))}
				</ul>
			)}
			{person !== undefined && (
				<button type="button" className="row link-row" onClick={() => navigate(personPath(person.id))}>
					<Icon name="message" />
					<span className="grow">{copy.personScreen.open}</span>
				</button>
			)}
			<UserLinkSuggestions store={store} userId={userId} suggestions={suggestions} />
			{people.status === "error" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.common.loadFailed}</span>
					<button type="button" className="btn btn-sm" onClick={() => void store.refresh()}>
						{copy.common.retry}
					</button>
				</div>
			)}
			<button type="button" className="row link-row" aria-haspopup="dialog" onClick={() => setPicking(true)}>
				<Icon name="link" />
				<span className="grow">{t.linkWith}</span>
			</button>
			{picking && <LinkPickerDialog store={store} userId={userId} name={name} linked={linked} onClose={() => setPicking(false)} />}
		</div>
	);
}
