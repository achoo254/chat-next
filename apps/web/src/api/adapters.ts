// The one place where protocol messages become client models (ADR 0001):
// every int64 field arrives as a bigint and leaves as a number checked by
// assertSafeId, so the rest of the app never sees a bigint.
import { assertSafeId } from "@achoo254/chat-core";
import { ClientPlatform, type Session } from "@achoo254/chat-proto/auth";
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
	/** Set while the account waits for deletion (GetSelfResponse.deletion): the app then only offers to cancel it. */
	deletion?: AccountDeletionInfo;
}

/** An account in its deletion grace period. */
export interface AccountDeletionInfo {
	/** Unix seconds when the account is erased unless cancelled. */
	purgeAt: number;
	/** "user": the user asked for it; "inactive": unused for the auto-delete period. */
	reason: "user" | "inactive";
}

export type SessionPlatform = "web" | "ios" | "android" | "unknown";

export interface SessionView {
	id: number;
	platform: SessionPlatform;
	deviceName: string;
	appVersion: string;
	location: string;
	/** Unix seconds. */
	createdAt: number;
	/** Unix seconds. */
	lastActiveAt: number;
	current: boolean;
	newLogin: boolean;
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
	};
}

const PLATFORMS: Record<ClientPlatform, SessionPlatform> = {
	[ClientPlatform.UNSPECIFIED]: "unknown",
	[ClientPlatform.WEB]: "web",
	[ClientPlatform.IOS]: "ios",
	[ClientPlatform.ANDROID]: "android",
	// Retired (desktop is the web app as a PWA); the server never returns it.
	[ClientPlatform.DESKTOP]: "unknown",
};

export function toSessionView(session: Session): SessionView {
	return {
		id: assertSafeId(session.id),
		platform: PLATFORMS[session.platform] ?? "unknown",
		deviceName: session.deviceName,
		appVersion: session.appVersion,
		location: session.location,
		createdAt: assertSafeId(session.createdAt),
		lastActiveAt: assertSafeId(session.lastActiveAt),
		current: session.current,
		newLogin: session.newLogin,
	};
}
