// A group's or channel's name, description and photo (mockups/chat.html#edit-chat),
// opened from the pencil of the info column by those allowed to change them.
// The photo is chosen and cropped at once but uploaded only on "Lưu"; each
// change becomes a service message in the chat.
import { useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { ChatInfoChanges } from "../data/remote.ts";
import { useChat, useServices } from "../data/services.tsx";
import { ChatAvatar, chatPhoto, DialogHead, Modal, useDomId } from "./parts.tsx";
import { usePhotoDraft, useUploadPhoto } from "./photo-crop.tsx";

const TITLE_MAX = 128;
const ABOUT_MAX = 255;

export default function EditChatDialog({ chatId, onClose }: { chatId: number; onClose: () => void }) {
	const chat = useChat(chatId);
	if (chat === null || chat === undefined) return null;
	return <EditChatForm chat={chat} onClose={onClose} />;
}

function EditChatForm({ chat, onClose }: { chat: NonNullable<ReturnType<typeof useChat>>; onClose: () => void }) {
	const copy = useScreensCopy();
	const t = copy.editChat;
	const { remote, toasts } = useServices();
	const upload = useUploadPhoto();
	const photo = usePhotoDraft("pick-chat-photo");
	const channel = chat.type === "channel";
	const id = useDomId("edit-chat");
	const [title, setTitle] = useState(chat.title);
	const [about, setAbout] = useState(chat.about);
	const [removePhoto, setRemovePhoto] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const currentPhoto = chat.photoId ?? "";
	const hasPhoto = photo.draft !== null || (currentPhoto !== "" && !removePhoto);

	const save = async () => {
		const name = title.trim();
		if (name === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		try {
			const changes: { -readonly [K in keyof ChatInfoChanges]: ChatInfoChanges[K] } = {};
			if (name !== chat.title) changes.title = name;
			if (about.trim() !== chat.about) changes.about = about.trim();
			if (photo.draft !== null) changes.photoFileId = await upload(photo.draft.blob);
			else if (removePhoto && currentPhoto !== "") changes.photoFileId = "";
			if (Object.keys(changes).length > 0) await remote.updateChatInfo(chat.id, changes);
			toasts.show(t.saved(channel));
			onClose();
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.title(channel)} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="name-row">
					{photo.draft !== null ? (
						<span className="avatar xl" aria-hidden="true">
							<img className="avatar-photo" src={photo.draft.url} alt="" />
						</span>
					) : (
						<ChatAvatar id={chat.id} name={title} size="xl" {...(removePhoto ? {} : chatPhoto(chat, null))} />
					)}
					<div className="photo-actions">
						<div>
							<button
								type="button"
								className="btn"
								onClick={() => {
									setRemovePhoto(false);
									photo.open();
								}}
							>
								<Icon name="camera" />
								{hasPhoto ? copy.photo.change : copy.photo.choose}
							</button>
							{hasPhoto && (
								<button
									type="button"
									className="btn-danger-text"
									onClick={() => {
										photo.clear();
										setRemovePhoto(true);
									}}
								>
									{copy.photo.remove}
								</button>
							)}
						</div>
						{removePhoto && currentPhoto !== "" && <span className="hint">{t.removeLater}</span>}
						{photo.error !== "" && (
							<span className="error-text" role="alert">
								{photo.error}
							</span>
						)}
					</div>
				</div>
				<div className="field">
					<label htmlFor={`${id}-name`}>{t.name(channel)}</label>
					<input
						id={`${id}-name`}
						className="input"
						maxLength={TITLE_MAX}
						value={title}
						aria-invalid={invalid}
						onChange={(event) => {
							setTitle(event.target.value);
							setInvalid(false);
						}}
					/>
					{invalid && <span className="error-text">{t.nameRequired}</span>}
				</div>
				<div className="field">
					<label htmlFor={`${id}-about`}>
						{t.about} <span className="muted">{t.optional}</span>
					</label>
					<textarea id={`${id}-about`} className="input" rows={3} maxLength={ABOUT_MAX} value={about} onChange={(event) => setAbout(event.target.value)} />
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void save()}>
					{busy ? t.saving : t.save}
				</button>
			</div>
			{photo.elements}
		</Modal>
	);
}
