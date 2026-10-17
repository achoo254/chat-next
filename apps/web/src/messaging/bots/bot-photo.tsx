// The bot's photo on its Profile tab (mockups/console.html#bot-photo):
// choose a JPEG, PNG or WebP up to 5 MB, place and zoom it in a square crop
// dialog (the circle is what users see), then it is cut to 640×640 on the
// device, uploaded and set at once; "Xoá ảnh" asks once.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import type { OwnBot } from "./api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useBotsCopy } from "./use-bots-copy.ts";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
/** Side of the uploaded square, in pixels. */
const OUTPUT = 640;
const MAX_ZOOM = 4;
/** Arrow keys move the photo this many stage pixels. */
const KEY_STEP = 10;

export function BotPhotoField({ bot, onSaved }: { bot: OwnBot; onSaved: (bot: OwnBot) => void }) {
	const t = useBotsCopy().photo;
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const picker = useRef<HTMLInputElement>(null);
	const [cropping, setCropping] = useState<HTMLImageElement | null>(null);
	const [error, setError] = useState("");
	const [removing, setRemoving] = useState<"confirm" | "busy" | null>(null);
	const hintId = useDomId("photo-hint");

	const pick = (file: File | undefined) => {
		setError("");
		if (file === undefined) return;
		if (!TYPES.includes(file.type)) return setError(t.notImage);
		if (file.size > MAX_BYTES) return setError(t.tooBig);
		const url = URL.createObjectURL(file);
		const image = new Image();
		// The URL stays valid while the crop dialog shows the image.
		image.onload = () => setCropping(image);
		image.onerror = () => {
			URL.revokeObjectURL(url);
			setError(t.unreadable);
		};
		image.src = url;
	};

	const remove = () => {
		setRemoving("busy");
		bots.update(bot.id, { photoFileId: "" }).then(
			(saved) => {
				setRemoving(null);
				onSaved(saved);
				toasts.show(t.removed);
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
							{bot.photoId === "" ? t.choose : t.change}
						</button>
						{bot.photoId !== "" && (
							<button type="button" className="btn btn-sm btn-danger-text" onClick={() => setRemoving("confirm")}>
								{t.remove}
							</button>
						)}
					</div>
					<span className="hint" id={hintId}>
						{t.hint}
					</span>
					{error !== "" && (
						<span className="error-text" role="alert">
							{error}
						</span>
					)}
				</div>
				<input
					ref={picker}
					type="file"
					accept={TYPES.join(",")}
					hidden
					tabIndex={-1}
					aria-hidden="true"
					data-testid="pick-bot-photo"
					onChange={(event) => {
						pick(event.target.files?.[0]);
						event.target.value = "";
					}}
				/>
			</div>
			{cropping !== null && (
				<CropDialog
					bot={bot}
					image={cropping}
					onSaved={onSaved}
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
					action={t.remove}
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

/** Where the photo sits in the square stage: its zoom and top-left corner, in stage pixels. */
interface Placement {
	readonly zoom: number;
	readonly x: number;
	readonly y: number;
}

/** Keeps the photo covering the whole stage. */
function clamp(p: Placement, image: HTMLImageElement, stage: number): Placement {
	const scale = (stage / Math.min(image.naturalWidth, image.naturalHeight)) * p.zoom;
	const w = image.naturalWidth * scale;
	const h = image.naturalHeight * scale;
	return { zoom: p.zoom, x: Math.min(0, Math.max(stage - w, p.x)), y: Math.min(0, Math.max(stage - h, p.y)) };
}

function CropDialog({ bot, image, onSaved, onClose }: { bot: OwnBot; image: HTMLImageElement; onSaved: (bot: OwnBot) => void; onClose: () => void }) {
	const t = useBotsCopy().photo;
	const copy = useCopy();
	const { bots, source, toasts } = useServices();
	const id = useDomId("crop");
	const stageRef = useRef<HTMLDivElement>(null);
	const [stage, setStage] = useState(320);
	const [place, setPlace] = useState<Placement>({ zoom: 1, x: 0, y: 0 });
	const [saving, setSaving] = useState(false);
	const drag = useRef<{ x: number; y: number; from: Placement } | null>(null);

	// The stage is square and as wide as the dialog allows; start centred.
	useEffect(() => {
		const width = stageRef.current?.clientWidth ?? 320;
		setStage(width);
		const scale = width / Math.min(image.naturalWidth, image.naturalHeight);
		setPlace({ zoom: 1, x: (width - image.naturalWidth * scale) / 2, y: (width - image.naturalHeight * scale) / 2 });
	}, [image]);

	const scale = (stage / Math.min(image.naturalWidth, image.naturalHeight)) * place.zoom;
	const move = (dx: number, dy: number, from = place) => setPlace(clamp({ ...from, x: from.x + dx, y: from.y + dy }, image, stage));
	const zoomTo = (zoom: number) => {
		// Zoom around the stage's centre.
		const ratio = zoom / place.zoom;
		const c = stage / 2;
		setPlace(clamp({ zoom, x: c - (c - place.x) * ratio, y: c - (c - place.y) * ratio }, image, stage));
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, y: event.clientY, from: place };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (d !== null) move(event.clientX - d.x, event.clientY - d.y, d.from);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[event.key];
		if (step === undefined) return;
		event.preventDefault();
		move(step[0] ?? 0, step[1] ?? 0);
	};

	const save = async () => {
		setSaving(true);
		try {
			const canvas = document.createElement("canvas");
			canvas.width = OUTPUT;
			canvas.height = OUTPUT;
			const ctx = canvas.getContext("2d");
			if (ctx === null) throw new Error("no canvas");
			ctx.drawImage(image, -place.x / scale, -place.y / scale, stage / scale, stage / scale, 0, 0, OUTPUT, OUTPUT);
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
			if (blob === null) throw new Error("no image");
			const fileId = await source.uploadPhoto(blob, "bot-photo.jpg");
			const saved = await bots.update(bot.id, { photoFileId: fileId });
			onSaved(saved);
			toasts.show(t.saved);
			onClose();
		} catch {
			setSaving(false);
			toasts.show(copy.common.failed);
		}
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.cropTitle} onClose={onClose} />
			<div className="dlg-body">
				<div
					ref={stageRef}
					className="crop-stage"
					role="img"
					aria-label={t.cropStage}
					tabIndex={0}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={() => (drag.current = null)}
					onPointerCancel={() => (drag.current = null)}
					onKeyDown={onKeyDown}
				>
					<img
						src={image.src}
						alt=""
						draggable={false}
						style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale, transform: `translate(${place.x}px, ${place.y}px)` }}
					/>
				</div>
				<label className="crop-zoom">
					<span className="sr-only">{t.zoom}</span>
					<input type="range" min={1} max={MAX_ZOOM} step={0.01} value={place.zoom} onChange={(event) => zoomTo(Number(event.target.value))} />
				</label>
				<p className="hint">{t.cropHint}</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" disabled={saving} aria-busy={saving} onClick={() => void save()}>
					{saving ? t.saving : t.save}
				</button>
			</div>
		</Modal>
	);
}
