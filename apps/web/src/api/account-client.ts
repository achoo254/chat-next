// Connect implementation of the account calls other than GetSelf (profile,
// username), loaded with the first of them (see client.ts).
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { UsersService, type User } from "@achoo254/chat-proto/users";
import { toSelfUser, type SelfUser } from "./adapters.ts";
import type { AccountCalls } from "./client.ts";

function requireUser(user: User | undefined, method: string): SelfUser {
	if (!user) {
		throw new ConnectError(`${method} returned no user`, Code.Internal);
	}
	return toSelfUser(user);
}

export function createAccountCalls(transport: Transport): AccountCalls {
	const users = createClient(UsersService, transport);
	return {
		updateProfile: async (changes) => requireUser((await users.updateProfile(changes)).user, "UpdateProfile"),
		setUsername: async (username) => requireUser((await users.setUsername({ username })).user, "SetUsername"),
	};
}
