// The bot's photo on its Profile tab (mockups/console.html#bot-photo):
// choose and crop it (ui/photo-crop.tsx), then it is uploaded and set at
// once; "Xoá ảnh" asks once.
import { useRef, useState } from "react";
import { useCopy } from "../copy/use-copy.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, useDomId } from "../ui/parts.tsx";
import { CropDialog, PhotoInput, useUploadPhoto } from "../ui/photo-crop.tsx";
import type { OwnBot } from "./api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useBotsCopy } from "./use-bots-copy.ts";

export function BotPhotoField({ bot, onSaved }: { bot: OwnBot; onSaved: (bot: OwnBot) => void }) {
	const t = useBotsCopy().photo;
	const shared = useScreensCopy().photo;
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const upload = useUploadPhoto();
	const picker = useRef<HTMLInputElement>(null);
	const [cropping, setCropping] = useState<HTMLImageElement | null>(null);
	const [error, setError] = useState("");
	const [removing, setRemoving] = useState<"confirm" | "busy" | null>(null);
	const hintId = useDomId("photo-hint");

	const remove = () => {
		setRemoving("busy");
		bots.update(bot.id, { photoFileId: "" }).then(
			(saved) => {
				setRemoving(null);
				onSaved(saved);
				toasts.show(shared.removed);
			},
			() => {
				setRemoving(null);
				toasts.show(copy.common.failed);
			},
		);
	};

	return (
		<div className="field">
			<span className="label">{t.label}</span>
			<div className="photo-row">
				<ChatAvatar id={bot.id} name={bot.name} size="xl" bot photoOf={bot.id} photoId={bot.photoId} />
				<div className="photo-actions">
					<div>
						<button type="button" className="btn btn-sm" aria-describedby={hintId} onClick={() => picker.current?.click()}>
							{bot.photoId === "" ? shared.choose : shared.change}
						</button>
						{bot.photoId !== "" && (
							<button type="button" className="btn btn-sm btn-danger-text" onClick={() => setRemoving("confirm")}>
								{shared.remove}
							</button>
						)}
					</div>
					<span className="hint" id={hintId}>
						{shared.hint}
					</span>
					{error !== "" && (
						<span className="error-text" role="alert">
							{error}
						</span>
					)}
				</div>
				<PhotoInput inputRef={picker} testId="pick-bot-photo" onImage={setCropping} onError={setError} />
			</div>
			{cropping !== null && (
				<CropDialog
					image={cropping}
					saveLabel={shared.save}
					onCropped={async (blob) => {
						const saved = await bots.update(bot.id, { photoFileId: await upload(blob) });
						onSaved(saved);
						toasts.show(shared.saved);
					}}
					onClose={() => {
						URL.revokeObjectURL(cropping.src);
						setCropping(null);
					}}
				/>
			)}
			{removing !== null && (
				<ConfirmDialog
					title={t.removeTitle(bot.name)}
					body={<p className="dlg-lede">{t.removeBody}</p>}
					action={shared.remove}
					busyLabel={t.removing}
					busy={removing === "busy"}
					danger
					onConfirm={remove}
					onClose={() => setRemoving(null)}
				/>
			)}
		</div>
	);
}
