// The contact line of a profile, the 1-1 info column and the contacts card
// (mockups/chat.html#user-profile, #info-panels, #contacts): whether the
// person is in your contacts and since when, with one button to add or
// remove them. Adding someone changes only your list, never theirs.
import { Code, ConnectError } from "@connectrpc/connect";
import { useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { contactsOf, useContacts } from "../data/contacts.ts";
import { shortDate } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { Glyph } from "./glyphs.tsx";

export function ContactRow({ userId, name }: { userId: number; name: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const contacts = useContacts(remote);
	const [busy, setBusy] = useState(false);
	if (contacts.status !== "ready") return null;
	const inList = contacts.ids.has(userId);
	const addedAt = contacts.entries.find((entry) => entry.person.id === userId)?.addedAt ?? 0;
	const t = copy.contacts;
	const toggle = () => {
		setBusy(true);
		const store = contactsOf(remote);
		(inList ? store.remove(userId) : store.add({ userId }).then(() => undefined))
			.then(
				() => toasts.show(inList ? t.removed(name) : t.added(name)),
				(err: unknown) => toasts.show(ConnectError.from(err).code === Code.FailedPrecondition ? t.full : copy.common.failed),
			)
			.finally(() => setBusy(false));
	};
	return (
		<div className="row contact-state" data-state={inList ? "in" : "out"}>
			{inList ? <Glyph name="user-check" /> : <Icon name="user" />}
			<span className="grow">
				<span className="contact-title">{inList ? t.inList : t.notInList}</span>
				<small>{inList ? (addedAt > 0 ? t.addedOn(shortDate(addedAt, locale)) : t.inListSub) : t.notInListSub}</small>
			</span>
			<button type="button" className={inList ? "btn btn-compact" : "btn btn-compact btn-primary"} aria-busy={busy} disabled={busy} onClick={toggle}>
				{inList ? <Glyph name="user-minus" /> : <Icon name="user-plus" />}
				<span>{inList ? t.removeFrom : t.addTo}</span>
			</button>
		</div>
	);
}
