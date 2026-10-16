// What the user sees when opening a private chat fails (CreatePrivate). A
// refusal by the other person (their "Nhắn tin cho tôi" setting, or a block)
// gets neutral copy that reveals neither, plus a hint about invite links
// when the user has a way to use one: they share a group with the person,
// or they may invite people to one of their groups or channels.
import { Code, ConnectError } from "@connectrpc/connect";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";

/** The server's prefix for the caller's own account restriction, also a PermissionDenied. */
const ACCOUNT_RESTRICTED = "account_restricted";
/** The server's prefixes for its anti-spam refusals (ResourceExhausted). */
const STRANGER_LIMIT = "stranger_chat_limit";
const STRANGER_PAUSED = "stranger_chat_paused";

/** CreatePrivate was refused by the other person, not by the caller's own account state. */
export function isPrivateChatRefused(err: unknown): boolean {
	const error = ConnectError.from(err);
	return error.code === Code.PermissionDenied && !error.rawMessage.startsWith(ACCOUNT_RESTRICTED);
}

/** Shows the toast for a failed CreatePrivate with userId. */
export function usePrivateChatFailure(): (err: unknown, userId: number) => void {
	const copy = useCopy();
	const { store, remote, toasts } = useServices();
	return (err, userId) => {
		const error = ConnectError.from(err);
		if (error.code === Code.ResourceExhausted && error.rawMessage.startsWith(STRANGER_LIMIT)) {
			toasts.show(copy.common.strangerLimit);
			return;
		}
		if (error.code === Code.ResourceExhausted && error.rawMessage.startsWith(STRANGER_PAUSED)) {
			toasts.show(copy.common.strangerPaused);
			return;
		}
		if (!isPrivateChatRefused(err)) {
			toasts.show(copy.common.failed);
			return;
		}
		const show = (hint: boolean): void =>
			toasts.show(hint ? `${copy.common.privateRefused} ${copy.common.privateRefusedInviteHint}` : copy.common.privateRefused);
		if (store.canInviteSomewhere()) {
			show(true);
			return;
		}
		remote.commonChats(userId).then(
			({ count }) => show(count > 0),
			() => show(false),
		);
	};
}
