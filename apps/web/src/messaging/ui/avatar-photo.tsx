// The picture of an avatar with a profile photo (bots so far), drawn over
// the initials or icon until it loads; loaded with the first such avatar.
import { useMediaFile } from "../media/use-media.ts";

interface AvatarPhotoProps {
	userId: number;
	fileId: string;
	/** Large avatars (profiles) ask for the medium rendition. */
	large: boolean;
}

export default function AvatarPhoto({ userId, fileId, large }: AvatarPhotoProps) {
	const { state } = useMediaFile({ chatId: 0, seq: 0, fileId, userPhotoOf: userId, kind: "photo", size: large ? "m" : "s" });
	return state.status === "ok" ? <img className="avatar-photo" src={state.url} alt="" /> : null;
}
