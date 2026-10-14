// Typed façade over the Connect services used by the web app. Components call
// these methods and only ever see client models from ./adapters.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService } from "@app/proto-ts/auth";
import { UsersService, type User } from "@app/proto-ts/users";
import { toSelfUser, toSessionView, type SelfUser, type SessionView } from "./adapters.ts";

export interface ProfileChanges {
	name?: string;
	bio?: string;
}

export interface Api {
	getSelf(): Promise<SelfUser>;
	updateProfile(changes: ProfileChanges): Promise<SelfUser>;
	setUsername(username: string): Promise<SelfUser>;
	listSessions(): Promise<SessionView[]>;
	revokeSession(id: number): Promise<void>;
	/** Returns how many sessions were revoked. */
	revokeOtherSessions(): Promise<number>;
}

/** Same-origin Connect transport; the HttpOnly session cookie rides along. */
export function createWebTransport(): Transport {
	return createConnectTransport({
		baseUrl: "/rpc",
		useBinaryFormat: true,
		fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
	});
}

/** The Connect error code of `err`, or Unknown for anything else that was thrown. */
export function errorCode(err: unknown): Code {
	return ConnectError.from(err).code;
}

function requireUser(user: User | undefined, method: string, isOperator = false): SelfUser {
	if (!user) {
		throw new ConnectError(`${method} returned no user`, Code.Internal);
	}
	return toSelfUser(user, isOperator);
}

/**
 * Builds the API on `transport`. `onUnauthenticated` runs whenever the server
 * says the session is gone (signed out, revoked, expired), so the app can drop
 * back to the welcome screen from any call site; the error is still rethrown.
 */
export function createApi(transport: Transport, onUnauthenticated: () => void): Api {
	const users = createClient(UsersService, transport);
	const auth = createClient(AuthService, transport);

	async function call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			if (errorCode(err) === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	}

	return {
		getSelf: () =>
			call(async () => {
				const response = await users.getSelf({});
				return requireUser(response.user, "GetSelf", response.isOperator);
			}),
		updateProfile: (changes) =>
			call(async () => requireUser((await users.updateProfile(changes)).user, "UpdateProfile")),
		setUsername: (username) =>
			call(async () => requireUser((await users.setUsername({ username })).user, "SetUsername")),
		listSessions: () =>
			call(async () => (await auth.listSessions({})).sessions.map(toSessionView)),
		revokeSession: (id) =>
			call(async () => {
				await auth.revokeSession({ sessionId: BigInt(id) });
			}),
		revokeOtherSessions: () => call(async () => (await auth.revokeOtherSessions({})).revokedCount),
	};
}
