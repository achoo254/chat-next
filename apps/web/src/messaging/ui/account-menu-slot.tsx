// Where the account menu goes (the folder rail, the settings screens' rail,
// the narrow chat list's top bar). The menu (account-menu.tsx) and the
// shared shell's stylesheet load just after the first screen, keeping them
// out of the startup budget (test/perf/budgets.ts); until then the user's
// avatar stands in its place, in the same box.
//
// The avatar: the photo the user uploaded to Chat, else the IdP picture,
// else the initials.
import { lazy, Suspense } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { OPEN_EXTERNAL } from "../../components/open-in-system-browser.ts";
import { ChatAvatar } from "./parts.tsx";

const ChatAccountMenu = lazy(() => import("./account-menu.tsx"));

/**
 * Chat draws the avatar (its photo or initials) unless the IdP picture is
 * what should show: the shared button draws only that, an https picture,
 * while a chat photo is a blob: URL of a downloaded file.
 */
export function drawsChatAvatar(self: Pick<SelfUser, "photoId" | "idpPicture">): boolean {
	return self.photoId !== undefined || self.idpPicture?.startsWith("https://") !== true;
}

/** The user's avatar as Chat draws it (photo or initials). */
export function ChatSelfAvatar({ self }: { self: SelfUser }) {
	"use no memo";
	return <ChatAvatar id={self.id} name={self.name} size="sm" photoOf={self.id} photoId={self.photoId} />;
}

/** The avatar in the menu button's box, while the menu loads. */
export function AvatarStandIn({ self }: { self: SelfUser }) {
	"use no memo";
	return (
		<div className="chat-account">
			<span className="chat-account-stand-in">
				{drawsChatAvatar(self) ? (
					<ChatSelfAvatar self={self} />
				) : (
					<span className="avatar sm" aria-hidden="true">
						<img className="avatar-photo" src={self.idpPicture} alt="" referrerPolicy="no-referrer" />
					</span>
				)}
			</span>
		</div>
	);
}

export function AccountMenuSlot({ self }: { self: SelfUser }) {
	"use no memo";
	return (
		<Suspense fallback={<AvatarStandIn self={self} />}>
			<ChatAccountMenu
				self={self}
				onOpenExternal={OPEN_EXTERNAL}
				photo={drawsChatAvatar(self) ? <ChatSelfAvatar self={self} /> : null}
			/>
		</Suspense>
	);
}
