// The one place where protocol messages become client models (ADR 0001):
// every int64 field arrives as a bigint and leaves as a number checked by
// assertSafeId, so the rest of the app never sees a bigint.
import { assertSafeId } from "@achoo254/chat-core";
import type { User } from "@achoo254/chat-proto/users";

export interface SelfUser {
	id: number;
	/** Empty when the user has none yet. */
	username: string;
	name: string;
	bio: string;
	/** Verified email from the IdP; empty when there is none. */
	email: string;
	/** May use the moderation queue (GetSelfResponse.is_operator). */
	isOperator: boolean;
	/** file_id of the profile photo; absent without one. */
	photoId?: string;
	/** https URL of the IdP account's picture (User.idp_picture), shown where there is no chat photo; absent without one. */
	idpPicture?: string;
}

/** `isOperator` comes with GetSelf only; profile updates keep the value the app has. */
export function toSelfUser(user: User, isOperator = false): SelfUser {
	return {
		id: assertSafeId(user.id),
		username: user.username,
		name: user.name,
		bio: user.bio,
		email: user.email,
		isOperator,
		...(user.photo !== undefined && user.photo.fileId !== "" ? { photoId: user.photo.fileId } : {}),
		...(user.idpPicture !== "" ? { idpPicture: user.idpPicture } : {}),
	};
}
