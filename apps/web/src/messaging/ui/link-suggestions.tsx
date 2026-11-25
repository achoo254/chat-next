// Link suggestions (ADR 0025): pairs of users that may be the same person,
// computed by the server when asked and never linked automatically. Every row
// says in words why it is there: the same phone number on the other apps
// (strong, still waiting for "Nối") or the same name (weak, "not verified").
// Shown for one user in the info column of a private chat, and all of them
// on the contacts screen ("Gợi ý nối"), each with "Nối" and "Không phải".
import { Code, ConnectError } from "@connectrpc/connect";
import { useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import type { FullCopy } from "../copy/use-screens-copy.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { appName } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import type { LinkSuggestion, PersonMember } from "../people/people-api.ts";
import { usePeople, type PeopleStore } from "../people/people-store.ts";
import { useDomId } from "./parts.tsx";

/** The app a user belongs to as the screens name it: Chat for a Chat account. */
export function appLabel(app: string, copy: FullCopy): string {
	return app === "" ? copy.people.chatApp : appName(app);
}

/** "Name (App)": one identity in words, so buttons say which one they act on. */
export function identityLabel(member: PersonMember, copy: FullCopy): string {
	return copy.people.identity(member.name, appLabel(member.app, copy));
}

/** What to tell the user when a people call failed. */
export function peopleFailure(err: unknown, copy: FullCopy): string {
	const error = ConnectError.from(err);
	switch (error.code) {
		case Code.NotFound:
			return copy.people.notFound;
		case Code.Unimplemented:
			return copy.people.unsupported;
		case Code.InvalidArgument:
			return error.rawMessage.includes("at most") ? copy.people.tooMany : copy.common.failed;
		default:
			return copy.common.failed;
	}
}

/** A user's name with their app beside it, as a tag (the app is also in the text, never colour alone). */
export function IdentityName({ member }: { member: PersonMember }) {
	const copy = useScreensCopy();
	return (
		<span className="identity">
			<span className="identity-name">{member.name}</span>
			<span className="tag grey">{appLabel(member.app, copy)}</span>
		</span>
	);
}

interface SuggestionRowProps {
	store: PeopleStore;
	suggestion: LinkSuggestion;
	/** The users the row names: the other one in a user's info column, both on the contacts screen. */
	shown: readonly PersonMember[];
}

function SuggestionRow({ store, suggestion, shown }: SuggestionRowProps) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const [busy, setBusy] = useState(false);
	const t = copy.people;
	const { first, second } = suggestion;
	const a = identityLabel(first, copy);
	const b = identityLabel(second, copy);
	// The toast names the user the row is about (the other one in an info column).
	const linkedWith = (shown.length === 1 ? shown[0] : undefined) ?? second;
	const run = (action: () => Promise<unknown>, done: string) => {
		setBusy(true);
		action()
			.then(
				() => toasts.show(done),
				(err: unknown) => toasts.show(peopleFailure(err, copy)),
			)
			.finally(() => setBusy(false));
	};
	return (
		<li className="link-suggestion">
			<span className="grow">
				<span className="identities">
					{shown.map((member) => (
						<IdentityName key={member.userId} member={member} />
					))}
				</span>
				{suggestion.reason === "phone" && (
					<small>
						<Icon name="info" small />
						{t.samePhone}
					</small>
				)}
				{suggestion.reason === "name" && (
					<small>
						<Icon name="info" small />
						{t.sameName}
					</small>
				)}
			</span>
			<span className="suggestion-actions">
				<button
					type="button"
					className="btn btn-sm btn-primary"
					aria-label={t.linkLabel(a, b)}
					aria-busy={busy}
					disabled={busy}
					onClick={() => run(() => store.link([first.userId, second.userId]), t.linked(linkedWith.name))}
				>
					{t.link}
				</button>
				<button
					type="button"
					className="btn btn-sm"
					aria-label={t.notSameLabel(a, b)}
					disabled={busy}
					onClick={() => run(() => store.reject(first.userId, second.userId), t.rejected)}
				>
					{t.notSame}
				</button>
			</span>
		</li>
	);
}

/** The suggestions involving `userId`, naming only the other user of each pair. */
export function UserLinkSuggestions({ store, userId, suggestions }: { store: PeopleStore; userId: number; suggestions: readonly LinkSuggestion[] }) {
	if (suggestions.length === 0) return null;
	return (
		<ul className="link-suggestions">
			{suggestions.map((suggestion) => (
				<SuggestionRow
					key={`${suggestion.first.userId}:${suggestion.second.userId}`}
					store={store}
					suggestion={suggestion}
					shown={[suggestion.first.userId === userId ? suggestion.second : suggestion.first]}
				/>
			))}
		</ul>
	);
}

/** "Gợi ý nối" on the contacts screen: every pending suggestion; nothing when there is none. */
export function ContactsLinkSuggestions() {
	const copy = useScreensCopy();
	const [store, people] = usePeople(0);
	const id = useDomId("link-suggestions");
	const suggestions = people.suggestions.get(0) ?? [];
	if (people.status === "unsupported" || suggestions.length === 0) return null;
	return (
		<section className="contacts-suggestions" aria-labelledby={id}>
			<h3 id={id}>{copy.people.suggestionsTitle}</h3>
			<p className="note">{copy.people.suggestionsNote}</p>
			<ul className="link-suggestions">
				{suggestions.map((suggestion) => (
					<SuggestionRow
						key={`${suggestion.first.userId}:${suggestion.second.userId}`}
						store={store}
						suggestion={suggestion}
						shown={[suggestion.first, suggestion.second]}
					/>
				))}
			</ul>
		</section>
	);
}
