// RPC surface the core uses, typed by the generated Connect services so the
// production client and the test fake implement the same contract.
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { ChatsService } from "@achoo254/chat-proto/chats";
import { ConfigService } from "@achoo254/chat-proto/config";
import { MediaService } from "@achoo254/chat-proto/media";
import { MessagesService } from "@achoo254/chat-proto/messages";
import { ModerationService } from "@achoo254/chat-proto/moderation";
import { SearchService } from "@achoo254/chat-proto/search";
import { UpdatesService } from "@achoo254/chat-proto/updates";
import { UsersService } from "@achoo254/chat-proto/users";

/**
 * The methods marked optional below are optional so test doubles written
 * before they existed still fit; createRemoteApi always provides them.
 */
export interface RemoteApi {
	readonly updates: Pick<Client<typeof UpdatesService>, "getState" | "getDifference" | "getChatDifference">;
	readonly chats: Pick<Client<typeof ChatsService>, "getDialogs" | "getChat"> &
		Partial<
			Pick<
				Client<typeof ChatsService>,
				| "getPeerDialogs"
				| "setDialogMute"
				| "setDialogPinned"
				| "reorderPinnedDialogs"
				| "deleteChat"
				| "getCommonChats"
				| "setDialogUnreadMark"
				| "getChatOnlineCount"
				| "getNotificationSettings"
				| "setNotificationSettings"
			>
		>;
	readonly messages: Pick<
		Client<typeof MessagesService>,
		"sendMessage" | "editMessage" | "deleteMessages" | "readHistory" | "getHistory"
	> &
		Partial<
			Pick<
				Client<typeof MessagesService>,
				"getMessageReactions" | "getPinnedMessages" | "unpinAllMessages" | "sendMedia" | "sendAlbum"
			>
		>;
	readonly users: Pick<Client<typeof UsersService>, "getSelf" | "getUsers"> &
		Partial<Pick<Client<typeof UsersService>, "getBlockedUsers" | "getContacts">>;
	/** Operators only (GetSelfResponse.is_operator); others get permission_denied. */
	readonly moderation?: Client<typeof ModerationService>;
	/** Uploads and download URLs (R3). */
	readonly media?: Pick<
		Client<typeof MediaService>,
		"createUpload" | "completeUpload" | "abortUpload" | "getFileUrls"
	>;
	/** Server-issued limits (AppConfig). */
	readonly config?: Pick<Client<typeof ConfigService>, "getAppConfig">;
	/** Message search on the server (R4). */
	readonly search?: Pick<Client<typeof SearchService>, "searchMessages" | "searchChatMessages">;
}

export function createRemoteApi(transport: Transport): RemoteApi {
	return {
		updates: createClient(UpdatesService, transport),
		chats: createClient(ChatsService, transport),
		messages: createClient(MessagesService, transport),
		users: createClient(UsersService, transport),
		moderation: createClient(ModerationService, transport),
		media: createClient(MediaService, transport),
		config: createClient(ConfigService, transport),
		search: createClient(SearchService, transport),
	};
}

/**
 * How a failed call should be handled:
 * - unauthenticated: the session is gone; wipe local data and sign in again.
 * - retryable: network trouble, overload or a transient server fault; retry
 *   with backoff and the same idempotency key.
 * - permanent: the request itself was refused; retrying cannot help.
 */
export type FailureKind = "unauthenticated" | "retryable" | "permanent";

const RETRYABLE = new Set<Code>([
	Code.Canceled,
	Code.Unknown,
	Code.DeadlineExceeded,
	Code.ResourceExhausted,
	Code.Aborted,
	Code.Internal,
	Code.Unavailable,
]);

export function classifyFailure(err: unknown): FailureKind {
	const code = ConnectError.from(err).code;
	if (code === Code.Unauthenticated) return "unauthenticated";
	return RETRYABLE.has(code) ? "retryable" : "permanent";
}

/**
 * The server refused a call about one chat because the caller may not see
 * it (no longer a member) or it is gone, as opposed to a network fault.
 */
export function isChatRefusal(err: unknown): boolean {
	const code = ConnectError.from(err).code;
	return code === Code.PermissionDenied || code === Code.NotFound;
}

/** Thrown inside the core when the server says the session is gone. */
export class SessionEndedError extends Error {
	constructor(message = "session ended") {
		super(message);
		this.name = "SessionEndedError";
	}
}
