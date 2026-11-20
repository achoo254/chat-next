// In-memory people of the signed-in user for tests (UsersService people
// calls): links between users that are the same person, and link
// suggestions the test seeds. Mirrors the server's rules: only users the
// caller has a private chat with (NotFound otherwise), two to 20 distinct
// users per link, linking merges people, a person left with one user is
// removed, a rejected pair never comes back. Never imported by production code.
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { LinkSuggestionReason, type UsersService } from "@achoo254/chat-proto/users";

const LINK_MAX = 20;

export interface FakePeopleDeps {
	readonly selfId: number;
	nameOf(userId: number): string;
	/** The caller's private chat with the user; 0 when there is none. */
	chatWith(userId: number): number;
	/** The app the user belongs to; "" for a Chat account. */
	appOf(userId: number): string;
}

type PeopleCalls = Pick<ServiceImpl<typeof UsersService>, "listPeople" | "linkUsers" | "unlinkUser" | "listLinkSuggestions" | "rejectLinkSuggestion">;

const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

export class FakePeople {
	readonly people: { id: number; name: string; members: number[] }[] = [];
	/** Pairs the server would suggest (seeded by the test); filtered like the server does when listed. */
	readonly suggested: [number, number][] = [];
	readonly rejected = new Set<string>();
	/** Every call the app made, e.g. "link:3,4", "unlink:3", "reject:3:4", "suggestions:0". */
	readonly calls: string[] = [];
	/** Set: ListPeople answers with this error code. */
	listFailure: Code | null = null;
	/** Set: LinkUsers answers with this error code. */
	linkFailure: Code | null = null;
	private nextId = 1;

	constructor(private readonly deps: FakePeopleDeps) {}

	private member(userId: number) {
		return { userId: BigInt(userId), name: this.deps.nameOf(userId), app: this.deps.appOf(userId), chatId: BigInt(this.deps.chatWith(userId)) };
	}

	private wirePerson(person: { id: number; name: string; members: number[] }) {
		return { id: BigInt(person.id), name: person.name, members: person.members.map((id) => this.member(id)) };
	}

	private personOf(userId: number) {
		return this.people.find((person) => person.members.includes(userId));
	}

	/** Links users the way LinkUsers does (also for seeding a test). */
	link(userIds: readonly number[]): { id: number; name: string; members: number[] } {
		const ids = [...new Set(userIds)];
		if (ids.length < 2 || ids.length > LINK_MAX || ids.includes(this.deps.selfId)) {
			throw new ConnectError(ids.length > LINK_MAX ? `at most ${LINK_MAX} users` : "two or more different users are needed", Code.InvalidArgument);
		}
		if (ids.some((id) => this.deps.chatWith(id) === 0)) throw new ConnectError("user not found", Code.NotFound);
		const existing = this.people.filter((person) => person.members.some((id) => ids.includes(id))).sort((a, b) => a.id - b.id);
		const target = existing[0] ?? { id: this.nextId++, name: this.deps.nameOf(ids[0] ?? 0), members: [] };
		if (existing.length === 0) this.people.push(target);
		for (const other of existing.slice(1)) {
			target.members.push(...other.members);
			this.people.splice(this.people.indexOf(other), 1);
		}
		for (const id of ids) if (!target.members.includes(id)) target.members.push(id);
		return target;
	}

	handlers(): PeopleCalls {
		return {
			listPeople: () => {
				this.calls.push("people");
				if (this.listFailure !== null) throw new ConnectError("people unavailable", this.listFailure);
				return { people: this.people.map((person) => this.wirePerson(person)) };
			},
			linkUsers: (req) => {
				const ids = req.userIds.map(Number);
				this.calls.push(`link:${ids.join(",")}`);
				if (this.linkFailure !== null) throw new ConnectError("link refused", this.linkFailure);
				return { person: this.wirePerson(this.link(ids)) };
			},
			unlinkUser: (req) => {
				const userId = Number(req.userId);
				this.calls.push(`unlink:${userId}`);
				const person = this.personOf(userId);
				if (person === undefined) return {};
				person.members.splice(person.members.indexOf(userId), 1);
				if (person.members.length < 2) this.people.splice(this.people.indexOf(person), 1);
				return {};
			},
			listLinkSuggestions: (req) => {
				const userId = Number(req.userId);
				this.calls.push(`suggestions:${userId}`);
				const pending = this.suggested.filter(([a, b]) => {
					if (this.rejected.has(pairKey(a, b))) return false;
					const person = this.personOf(a);
					if (person !== undefined && person.members.includes(b)) return false;
					return userId === 0 || a === userId || b === userId;
				});
				return { suggestions: pending.map(([a, b]) => ({ first: this.member(a), second: this.member(b), reason: LinkSuggestionReason.NAME })) };
			},
			rejectLinkSuggestion: (req) => {
				const a = Number(req.userA);
				const b = Number(req.userB);
				this.calls.push(`reject:${a}:${b}`);
				this.rejected.add(pairKey(a, b));
				return {};
			},
		};
	}
}
