// Typed façade over the account calls of the web app (GetSelf, profile,
// sessions). Components call these methods and only ever see client models
// from ./adapters.
//
// Startup carries no protobuf runtime: GetSelf, the one call every start
// makes, goes over the Connect protocol's JSON encoding with plain fetch
// (get-self.ts), and the Connect transport, the generated schemas and the
// other account calls load on their first use (account-client.ts). Every
// RPC goes through one fetch function, so tests serve them all in memory.
import { Code, type Transport } from "@connectrpc/connect";
import type { SelfUser, SessionView } from "./adapters.ts";
import { fetchSelf, RPC_BASE_URL } from "./get-self.ts";

export interface ProfileChanges {
	name?: string;
	bio?: string;
	/** A photo the user uploaded; "" removes the photo. */
	photoFileId?: string;
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

/** The account calls other than GetSelf, implemented in account-client.ts. */
export type AccountCalls = Omit<Api, "getSelf">;

/** How the app reaches the server: fetch for same-origin /rpc requests. */
export type RpcFetch = typeof globalThis.fetch;

/** Same-origin requests; the HttpOnly session cookie rides along. */
export const sameOriginFetch: RpcFetch = (input, init) => fetch(input, { ...init, credentials: "same-origin" });

/** Loads `load()` once; a failed load is tried again on the next call. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
	let loading: Promise<T> | null = null;
	return () =>
		(loading ??= load().catch((err: unknown) => {
			loading = null;
			throw err;
		}));
}

/** Connect-Web's code; fetched ahead by screens whose first data comes through the web transport. */
export const loadConnectWeb = () => import("@connectrpc/connect-web");

/** The account calls' code (sessions, profile); fetched ahead like loadConnectWeb. */
export const loadAccountClient = () => import("./account-client.ts");

/**
 * Connect transport (binary encoding) at /rpc over `rpcFetch`. Connect-Web
 * and the protobuf runtime load with the first call made through it.
 */
export function createWebTransport(rpcFetch: RpcFetch): Transport {
	const load = once(() =>
		loadConnectWeb().then(({ createConnectTransport }) =>
			createConnectTransport({ baseUrl: RPC_BASE_URL, useBinaryFormat: true, fetch: rpcFetch }),
		),
	);
	return {
		unary: (method, signal, timeoutMs, header, input, contextValues) =>
			load().then((transport) => transport.unary(method, signal, timeoutMs, header, input, contextValues)),
		stream: (method, signal, timeoutMs, header, input, contextValues) =>
			load().then((transport) => transport.stream(method, signal, timeoutMs, header, input, contextValues)),
	};
}

/**
 * The Connect error code of `err`, or Unknown for anything else that was
 * thrown. Both ConnectError (the generated clients) and RpcError (GetSelf)
 * carry a numeric `code`; checking the shape keeps ConnectError, and the
 * protobuf runtime it pulls in, out of the startup bundle.
 */
export function errorCode(err: unknown): Code {
	if (err instanceof Error && "code" in err && typeof err.code === "number" && Code[err.code] !== undefined) {
		// A numeric Code member, checked just above.
		return err.code as Code;
	}
	return Code.Unknown;
}

/**
 * Builds the API. `onUnauthenticated` runs whenever the server says the
 * session is gone (signed out, revoked, expired), so the app can drop back
 * to the welcome screen from any call site; the error is still rethrown.
 */
export function createApi(transport: Transport, rpcFetch: RpcFetch, onUnauthenticated: () => void): Api {
	const account = once(() => loadAccountClient().then((module) => module.createAccountCalls(transport)));

	async function call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			if (errorCode(err) === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	}

	return {
		getSelf: () => call(() => fetchSelf(rpcFetch)),
		updateProfile: (changes) => call(async () => (await account()).updateProfile(changes)),
		setUsername: (username) => call(async () => (await account()).setUsername(username)),
		listSessions: () => call(async () => (await account()).listSessions()),
		revokeSession: (id) => call(async () => (await account()).revokeSession(id)),
		revokeOtherSessions: () => call(async () => (await account()).revokeOtherSessions()),
	};
}
