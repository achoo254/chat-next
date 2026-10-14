// The one place where protocol messages become client models (ADR 0001):
// every int64 field arrives as a bigint and leaves as a number checked by
// assertSafeId, so the rest of the app never sees a bigint.
import { assertSafeId } from "@app/core";
import { ClientPlatform, type Session } from "@app/proto-ts/auth";
import type { User } from "@app/proto-ts/users";

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
}

export type SessionPlatform = "web" | "ios" | "android" | "desktop" | "unknown";

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
	};
}

const PLATFORMS: Record<ClientPlatform, SessionPlatform> = {
	[ClientPlatform.UNSPECIFIED]: "unknown",
	[ClientPlatform.WEB]: "web",
	[ClientPlatform.IOS]: "ios",
	[ClientPlatform.ANDROID]: "android",
	[ClientPlatform.DESKTOP]: "desktop",
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
