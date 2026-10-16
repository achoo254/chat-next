// GetSelf over the Connect protocol's JSON encoding with plain fetch. It is
// the first request of every start and decides between the welcome screen
// and the signed-in app, so it runs before (and without) the protobuf
// runtime and the generated schemas, which stay out of the startup bundle.
// The server's Connect handlers accept JSON as well as binary
// (https://connectrpc.com/docs/protocol, unary requests).
import { Code } from "@connectrpc/connect";
import { assertSafeId } from "@app/core";
import type { AccountDeletionInfo, SelfUser } from "./adapters.ts";

export const RPC_BASE_URL = "/rpc";
const GET_SELF_URL = `${RPC_BASE_URL}/app.v1.UsersService/GetSelf`;

/** A failed JSON call, with the Connect code the server (or the HTTP status) gave. */
export class RpcError extends Error {
	readonly code: Code;

	constructor(code: Code, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

/** Connect error codes as they appear in a JSON error body. */
const CODES: Readonly<Record<string, Code>> = {
	canceled: Code.Canceled,
	unknown: Code.Unknown,
	invalid_argument: Code.InvalidArgument,
	deadline_exceeded: Code.DeadlineExceeded,
	not_found: Code.NotFound,
	already_exists: Code.AlreadyExists,
	permission_denied: Code.PermissionDenied,
	resource_exhausted: Code.ResourceExhausted,
	failed_precondition: Code.FailedPrecondition,
	aborted: Code.Aborted,
	out_of_range: Code.OutOfRange,
	unimplemented: Code.Unimplemented,
	internal: Code.Internal,
	unavailable: Code.Unavailable,
	data_loss: Code.DataLoss,
	unauthenticated: Code.Unauthenticated,
};

/** Code of an error response without a Connect body (a proxy answered), as the Connect protocol maps HTTP statuses. */
function codeOfStatus(status: number): Code {
	switch (status) {
		case 400:
			return Code.Internal;
		case 401:
			return Code.Unauthenticated;
		case 403:
			return Code.PermissionDenied;
		case 404:
			return Code.Unimplemented;
		case 429:
		case 502:
		case 503:
		case 504:
			return Code.Unavailable;
		default:
			return Code.Unknown;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A proto3 JSON string field: absent means "". */
function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (value === undefined) return "";
	if (typeof value !== "string") throw new RpcError(Code.Internal, `GetSelf: ${key} is not a string`);
	return value;
}

/** A proto3 JSON int64: a decimal string (numbers are accepted too); absent means 0. */
function int64(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (value === undefined) return 0;
	if (typeof value === "number") return assertSafeId(value);
	if (typeof value === "string" && /^-?\d+$/.test(value)) return assertSafeId(BigInt(value));
	throw new RpcError(Code.Internal, `GetSelf: ${key} is not an int64`);
}

/** Reads a GetSelfResponse in proto3 JSON (lowerCamelCase names, default values omitted). */
export function parseGetSelf(body: unknown): SelfUser {
	if (!isRecord(body) || !isRecord(body.user)) throw new RpcError(Code.Internal, "GetSelf returned no user");
	const user = body.user;
	const isOperator = body.isOperator ?? false;
	if (typeof isOperator !== "boolean") throw new RpcError(Code.Internal, "GetSelf: isOperator is not a boolean");
	const self: SelfUser = {
		id: int64(user, "id"),
		username: text(user, "username"),
		name: text(user, "name"),
		bio: text(user, "bio"),
		email: text(user, "email"),
		isOperator,
	};
	const deletion = parseDeletion(body.deletion);
	return deletion === null ? self : { ...self, deletion };
}

/** GetSelfResponse.deletion; null when the account is not waiting for deletion. */
function parseDeletion(value: unknown): AccountDeletionInfo | null {
	if (value === undefined) return null;
	if (!isRecord(value)) throw new RpcError(Code.Internal, "GetSelf: deletion is not an object");
	return { purgeAt: int64(value, "purgeAt"), reason: value.reason === "ACCOUNT_DELETION_REASON_INACTIVE" ? "inactive" : "user" };
}

/**
 * The signed-in user; RpcError with Unauthenticated when there is no session.
 * The request allows a signed-out answer (allow_signed_out): the server then
 * answers 200 without a user instead of 401, so a signed-out start logs no
 * failed request in the browser console.
 */
export async function fetchSelf(rpcFetch: typeof globalThis.fetch): Promise<SelfUser> {
	const response = await rpcFetch(GET_SELF_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
		body: '{"allowSignedOut":true}',
	});
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// Not JSON (a proxy error page): the status decides below.
	}
	if (!response.ok) {
		const code = isRecord(body) && typeof body.code === "string" ? CODES[body.code] : undefined;
		const message = isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
		throw new RpcError(code ?? codeOfStatus(response.status), message);
	}
	if (isRecord(body) && body.user === undefined) throw new RpcError(Code.Unauthenticated, "signed out");
	return parseGetSelf(body);
}
