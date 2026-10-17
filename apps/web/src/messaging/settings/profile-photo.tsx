// The user's own photo on Settings › Profile (mockups/settings.html#profile):
// "Đổi ảnh" chooses and crops it (ui/photo-crop.tsx), then it is uploaded
// and set at once; "Xoá ảnh" goes back to the initials. Who sees it is the
// "Ảnh đại diện" setting of Privacy.
import { useRef, useState } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { useApi } from "../../api/api-context.tsx";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, useDomId } from "../ui/parts.tsx";
import { CropDialog, PhotoInput, useUploadPhoto } from "../ui/photo-crop.tsx";

export default function ProfilePhotoField({ self, onSelfChange }: { self: SelfUser; onSelfChange: (self: SelfUser) => void }) {
	const t = useScreensCopy().photo;
	const copy = useCopy();
	const api = useApi();
	const { toasts } = useServices();
	const upload = useUploadPhoto();
	const picker = useRef<HTMLInputElement>(null);
	const [cropping, setCropping] = useState<HTMLImageElement | null>(null);
	const [error, setError] = useState("");
	const [removing, setRemoving] = useState(false);
	const hintId = useDomId("profile-photo-hint");
	const photoId = self.photoId ?? "";
	// Keeps what the server knows that this screen does not (operator access).
	const changed = (user: SelfUser) => onSelfChange({ ...self, ...user, isOperator: self.isOperator });

	const remove = () => {
		setRemoving(true);
		api.updateProfile({ photoFileId: "" }).then(
			(user) => {
				setRemoving(false);
				const { photoId: _gone, ...rest } = { ...self, ...user };
				onSelfChange({ ...rest, isOperator: self.isOperator });
				toasts.show(t.removed);
			},
			() => {
				setRemoving(false);
				toasts.show(copy.common.failed);
			},
		);
	};

	return (
		<>
			<ChatAvatar id={self.id} name={self.name} size="xl" photoOf={self.id} photoId={photoId} />
			<div className="photo-actions">
				<div>
					<button type="button" className="btn" aria-describedby={hintId} onClick={() => picker.current?.click()}>
						<Icon name="camera" />
						{photoId === "" ? t.choose : t.change}
					</button>
					{photoId !== "" && (
						<button type="button" className="btn-danger-text" disabled={removing} aria-busy={removing} onClick={remove}>
							{t.remove}
						</button>
					)}
				</div>
				<p className="note" id={hintId}>
					{t.profileHint}
				</p>
				{error !== "" && (
					<span className="error-text" role="alert">
						{error}
					</span>
				)}
			</div>
			<PhotoInput inputRef={picker} testId="pick-profile-photo" onImage={setCropping} onError={setError} />
			{cropping !== null && (
				<CropDialog
					image={cropping}
					saveLabel={t.save}
					onCropped={async (blob) => {
						changed(await api.updateProfile({ photoFileId: await upload(blob) }));
						toasts.show(t.saved);
					}}
					onClose={() => {
						URL.revokeObjectURL(cropping.src);
						setCropping(null);
					}}
				/>
			)}
		</>
	);
}
