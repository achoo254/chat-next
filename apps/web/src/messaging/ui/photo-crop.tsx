// Choosing a square photo (mockups/console.html#bot-photo, chat.html#edit-chat):
// a JPEG, PNG or WebP up to 5 MB is placed and zoomed in a square crop
// dialog (the circle is what users see), then cut to 640×640 on the device.
// Used for bots' photos, the user's own photo and groups' and channels' photos.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { useCopy } from "../copy/use-copy.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { DialogHead, Modal, useDomId } from "./parts.tsx";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
/** Side of the uploaded square, in pixels. */
const OUTPUT = 640;
const MAX_ZOOM = 4;
/** Arrow keys move the photo this many stage pixels. */
const KEY_STEP = 10;

/**
 * The hidden file input behind a "Chọn ảnh" button: it checks the type and
 * size and hands over the loaded image, or an error to show.
 */
export function PhotoInput({
	inputRef,
	testId,
	onImage,
	onError,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	testId: string;
	onImage: (image: HTMLImageElement) => void;
	onError: (message: string) => void;
}) {
	const t = useScreensCopy().photo;
	const pick = (file: File | undefined) => {
		onError("");
		if (file === undefined) return;
		if (!TYPES.includes(file.type)) return onError(t.notImage);
		if (file.size > MAX_BYTES) return onError(t.tooBig);
		const url = URL.createObjectURL(file);
		const image = new Image();
		// The URL stays valid while the crop dialog shows the image; its owner revokes it.
		image.onload = () => onImage(image);
		image.onerror = () => {
			URL.revokeObjectURL(url);
			onError(t.unreadable);
		};
		image.src = url;
	};
	return (
		<input
			ref={inputRef}
			type="file"
			accept={TYPES.join(",")}
			hidden
			tabIndex={-1}
			aria-hidden="true"
			data-testid={testId}
			onChange={(event) => {
				pick(event.target.files?.[0]);
				event.target.value = "";
			}}
		/>
	);
}

/** Uploads a cropped photo and returns its file_id. */
export function useUploadPhoto(): (blob: Blob) => Promise<string> {
	const { source } = useServices();
	return (blob) => source.uploadPhoto(blob, "photo.jpg");
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

/**
 * The crop dialog: `onCropped` gets the 640×640 JPEG; the dialog closes when
 * it resolves and stays open, with a toast, when it fails.
 */
export function CropDialog({
	image,
	saveLabel,
	onCropped,
	onClose,
}: {
	image: HTMLImageElement;
	saveLabel: string;
	onCropped: (blob: Blob) => Promise<void>;
	onClose: () => void;
}) {
	const t = useScreensCopy().photo;
	const copy = useCopy();
	const { toasts } = useServices();
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
			await onCropped(blob);
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
				{/* The stage is the picture being placed: drag it or use the arrow keys; the zoom slider below is a standard control. */}
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above */}
				<div
					ref={stageRef}
					className="crop-stage"
					role="img"
					aria-label={t.cropStage}
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the arrow keys move the picture, so the stage is in the tab order
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
					{saving ? t.saving : saveLabel}
				</button>
			</div>
		</Modal>
	);
}

/** A cropped photo not uploaded yet, with an object URL to show it. */
export interface PhotoDraft {
	readonly blob: Blob;
	readonly url: string;
}

/**
 * A photo chosen and cropped now, uploaded later (when the dialog that
 * holds it saves): `open` starts choosing, `elements` renders the hidden
 * input and the crop dialog.
 */
export function usePhotoDraft(testId: string): {
	readonly draft: PhotoDraft | null;
	readonly error: string;
	readonly open: () => void;
	readonly clear: () => void;
	readonly elements: ReactNode;
} {
	const t = useScreensCopy().photo;
	const picker = useRef<HTMLInputElement>(null);
	const [cropping, setCropping] = useState<HTMLImageElement | null>(null);
	const [draft, setDraft] = useState<PhotoDraft | null>(null);
	const [error, setError] = useState("");
	// The shown draft's URL goes with the draft, or with the dialog.
	useEffect(() => (draft === null ? undefined : () => URL.revokeObjectURL(draft.url)), [draft]);
	const elements = (
		<>
			<PhotoInput inputRef={picker} testId={testId} onImage={setCropping} onError={setError} />
			{cropping !== null && (
				<CropDialog
					image={cropping}
					saveLabel={t.use}
					onCropped={async (blob) => setDraft({ blob, url: URL.createObjectURL(blob) })}
					onClose={() => {
						URL.revokeObjectURL(cropping.src);
						setCropping(null);
					}}
				/>
			)}
		</>
	);
	return { draft, error, open: () => picker.current?.click(), clear: () => setDraft(null), elements };
}
