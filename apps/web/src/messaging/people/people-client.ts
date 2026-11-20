// Connect implementation of PeopleApi (see people-api.ts), with the protocol
// mapping (ADR 0001: every int64 arrives as a bigint and leaves as a number).
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@achoo254/chat-core";
import {
	LinkSuggestionReason,
	UsersService,
	type LinkSuggestion as WireSuggestion,
	type Person as WirePerson,
	type PersonMember as WireMember,
} from "@achoo254/chat-proto/users";
import type { LinkSuggestion, LinkedPerson, PeopleApi, PersonMember } from "./people-api.ts";

function toMember(member: WireMember): PersonMember {
	return { userId: assertSafeId(member.userId), name: member.name, app: member.app, chatId: assertSafeId(member.chatId) };
}

function toPerson(person: WirePerson): LinkedPerson {
	return { id: assertSafeId(person.id), name: person.name, members: person.members.map(toMember) };
}

/** null for a suggestion the server sent without both users (dropped, nothing to show). */
function toSuggestion(suggestion: WireSuggestion): LinkSuggestion | null {
	if (suggestion.first === undefined || suggestion.second === undefined) return null;
	return {
		first: toMember(suggestion.first),
		second: toMember(suggestion.second),
		reason: suggestion.reason === LinkSuggestionReason.NAME ? "name" : "other",
	};
}

export function createPeopleClient(transport: Transport): PeopleApi {
	const users = createClient(UsersService, transport);
	return {
		list: async () => (await users.listPeople({})).people.map(toPerson),
		link: async (userIds) => {
			const person = (await users.linkUsers({ userIds: userIds.map((id) => BigInt(id)) })).person;
			if (person === undefined) throw new ConnectError("LinkUsers returned no person", Code.Internal);
			return toPerson(person);
		},
		unlink: async (userId) => {
			await users.unlinkUser({ userId: BigInt(userId) });
		},
		suggestions: async (userId) => {
			const response = await users.listLinkSuggestions({ userId: BigInt(userId) });
			return response.suggestions.map(toSuggestion).filter((suggestion): suggestion is LinkSuggestion => suggestion !== null);
		},
		reject: async (userA, userB) => {
			await users.rejectLinkSuggestion({ userA: BigInt(userA), userB: BigInt(userB) });
		},
	};
}
