// The picture of an avatar with a photo (a user's or a chat's), drawn over
// the initials or icon until it loads; loaded with the first such avatar.
import { useMediaFile } from "../media/use-media.ts";

interface AvatarPhotoProps {
	/** Whose photo: a user (User.photoId) or a group or channel (Chat.photoId). */
	of: { readonly user: number } | { readonly chat: number };
	fileId: string;
	/** Large avatars (profiles) ask for the medium rendition. */
	large: boolean;
}

export default function AvatarPhoto({ of, fileId, large }: AvatarPhotoProps) {
	const context = "user" in of ? { userPhotoOf: of.user } : { chatPhotoOf: of.chat };
	const { state } = useMediaFile({ chatId: 0, seq: 0, fileId, ...context, kind: "photo", size: large ? "m" : "s" });
	return state.status === "ok" ? <img className="avatar-photo" src={state.url} alt="" /> : null;
}
