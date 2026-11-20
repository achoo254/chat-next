// The screen of a linked person (ADR 0025, /p/<id>): their name, each of
// their identities with a way to open that chat on its own, and the merged
// timeline of their private chats, and the composer that sends to the chats
// chosen on its target row (person-send.tsx). Laid out like a chat (header,
// messages, composer; on a phone a back button to the list). A person that is not (or no
// longer) among the caller's people says so, with a way back. Loaded when
// first opened (ui/chat-screen.tsx).
import { useLoader } from "../../components/delayed-loader.tsx";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { identityLabel, appLabel } from "../ui/link-suggestions.tsx";
import { ChatAvatar } from "../ui/parts.tsx";
import type { LinkedPerson } from "./people-api.ts";
import { usePeople } from "./people-store.ts";
import { PersonSend } from "./person-send.tsx";
import { PersonTimeline } from "./person-timeline.tsx";
import { usePersonSend } from "./use-person-send.ts";

function BackButton() {
	const copy = useScreensCopy();
	return (
		<button type="button" className="icon-btn narrow-only" aria-label={copy.convo.backToList} onClick={() => navigate(paths.home)}>
			<Icon name="back" />
		</button>
	);
}

/** "Mở chat <app>" for each identity with a private chat: the app as a tag, the identity's name in its tooltip. */
function Identities({ person }: { person: LinkedPerson }) {
	const copy = useScreensCopy();
	const members = person.members.filter((member) => member.chatId !== 0);
	if (members.length === 0) return null;
	return (
		<div className="person-ids" role="group" aria-label={copy.personScreen.identities}>
			{members.map((member) => (
				<button
					key={member.userId}
					type="button"
					className="tag grey person-id"
					title={identityLabel(member, copy)}
					aria-label={copy.people.openChat(appLabel(member.app, copy))}
					onClick={() => navigate(paths.chat(member.chatId))}
				>
					<Icon name="message" small />
					{appLabel(member.app, copy)}
				</button>
			))}
		</div>
	);
}

/** The timeline and the composer of one person: replying to or editing a message binds the composer to its chat. */
function PersonBody({ person }: { person: LinkedPerson }) {
	const send = usePersonSend(person);
	return (
		<>
			<PersonTimeline person={person} actions={send.actions} />
			<PersonSend person={person} send={send} />
		</>
	);
}

/** The person is not shown: unknown, unlinked meanwhile, or the people could not be listed. */
function Missing({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
	const copy = useScreensCopy();
	const t = copy.personScreen;
	return (
		<section className="convo person-screen">
			<header className="convo-head">
				<BackButton />
			</header>
			<div className="empty" role={failed ? "alert" : "status"}>
				<Icon name={failed ? "alert" : "message"} />
				<strong>{failed ? t.peopleFailed : t.notFound}</strong>
				{!failed && <span>{t.notFoundBody}</span>}
				{failed && (
					<button type="button" className="btn" onClick={onRetry}>
						{copy.common.retry}
					</button>
				)}
				<button type="button" className="btn" onClick={() => navigate(paths.home)}>
					{copy.convo.backToList}
				</button>
			</div>
		</section>
	);
}

export default function PersonScreen({ personId }: { personId: number }) {
	const copy = useScreensCopy();
	const [store, people] = usePeople(null);
	const person = people.people.find((candidate) => candidate.id === personId);
	const loader = useLoader(person === undefined && people.status === "loading", copy.common.loading);

	if (person === undefined) {
		if (loader !== null) {
			return (
				<section className="convo" aria-busy="true">
					{loader}
				</section>
			);
		}
		return <Missing failed={people.status === "error"} onRetry={() => void store.refresh()} />;
	}
	return (
		<section className="convo person-screen" aria-label={person.name}>
			<header className="convo-head">
				<BackButton />
				<ChatAvatar id={person.id} name={person.name} />
				<div className="title">
					<strong>{person.name}</strong>
					<span>{copy.personScreen.subtitle}</span>
				</div>
			</header>
			<Identities person={person} />
			<PersonBody key={person.id} person={person} />
		</section>
	);
}
