// Screenshots and screen recordings as files for the composer's tray: one
// frame of the shared screen, or the region dragged on it, as a PNG; a
// recording cropped to a region (where the browser can); the container chosen
// from what the browser records (MP4 first: it carries its length and plays
// everywhere; WebM otherwise), and file names that carry the local time.

/** A frame that does not arrive this fast fails the screenshot. */
const FRAME_TIMEOUT_MS = 5000;

/** Containers to record into, best first; the first the browser supports wins. */
const RECORDING_TYPES = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** "screenshot-20261127-134502.png": the kind of capture and the local time it was made. */
export function captureName(prefix: string, ext: string, at: Date): string {
	const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
	const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `${prefix}-${day}-${time}.${ext}`;
}

export function stopStream(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
}

/** Waits until the video element has a frame to draw. */
function firstFrame(video: HTMLVideoElement): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no frame from the shared screen")), FRAME_TIMEOUT_MS);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) done();
		else video.addEventListener("loadeddata", done, { once: true });
	});
}

/** A rectangle in pixels of the shared screen. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * A drag on the shown picture (client pixels, any direction) as a rectangle
 * of the shared screen, clamped to it. `shown` is where the picture is drawn,
 * `width`/`height` its real size. Null for a drag too small to mean a region.
 */
export function toSourceRect(
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number },
	shown: Rect,
	width: number,
	height: number,
	minShown = 8,
): Rect | null {
	if (!(shown.width > 0) || !(shown.height > 0)) return null;
	const clampX = (value: number) => Math.min(Math.max(value - shown.x, 0), shown.width);
	const clampY = (value: number) => Math.min(Math.max(value - shown.y, 0), shown.height);
	const left = Math.min(clampX(from.x), clampX(to.x));
	const right = Math.max(clampX(from.x), clampX(to.x));
	const top = Math.min(clampY(from.y), clampY(to.y));
	const bottom = Math.max(clampY(from.y), clampY(to.y));
	if (right - left < minShown || bottom - top < minShown) return null;
	const scaleX = width / shown.width;
	const scaleY = height / shown.height;
	return evenRect({ x: left * scaleX, y: top * scaleY, width: (right - left) * scaleX, height: (bottom - top) * scaleY }, width, height);
}

/** Whole, even pixels inside width × height: video frames crop only on even edges. */
export function evenRect(rect: Rect, width: number, height: number): Rect {
	const even = (value: number) => Math.max(0, Math.floor(value / 2) * 2);
	const x = Math.min(even(rect.x), Math.max(0, even(width) - 2));
	const y = Math.min(even(rect.y), Math.max(0, even(height) - 2));
	return { x, y, width: Math.max(2, Math.min(even(rect.width), even(width - x))), height: Math.max(2, Math.min(even(rect.height), even(height - y))) };
}

/** Takes one frame of a shared screen onto a canvas, then stops sharing. */
export async function grabFrame(stream: MediaStream): Promise<HTMLCanvasElement> {
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = stream;
	try {
		await video.play().catch(() => undefined);
		await firstFrame(video);
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("no 2d canvas");
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		video.srcObject = null;
		stopStream(stream);
	}
}

/** The region (or the whole frame when null) of a grabbed frame as a PNG file. */
export async function screenshotFile(frame: HTMLCanvasElement, region: Rect | null, at = new Date()): Promise<File> {
	let canvas = frame;
	if (region !== null) {
		canvas = document.createElement("canvas");
		canvas.width = region.width;
		canvas.height = region.height;
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("no 2d canvas");
		context.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
	}
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (blob === null) throw new Error("the screenshot could not be encoded");
	return new File([blob], captureName("screenshot", "png", at), { type: "image/png" });
}

/** The parts of mediacapture-transform used to crop a recording (Chrome and Edge expose them on the page). */
interface FrameProcessor {
	readonly readable: ReadableStream<VideoFrame>;
}
interface FrameGenerator extends MediaStreamTrack {
	readonly writable: WritableStream<VideoFrame>;
}
interface TransformApi {
	readonly MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => FrameProcessor;
	readonly MediaStreamTrackGenerator?: new (init: { kind: "video" }) => FrameGenerator;
}

/** Whether this browser can record only a region of the shared screen. */
export function canCropRecording(): boolean {
	const api = globalThis as TransformApi;
	return (
		typeof api.MediaStreamTrackProcessor === "function" &&
		typeof api.MediaStreamTrackGenerator === "function" &&
		typeof VideoFrame === "function" &&
		typeof OffscreenCanvas === "function"
	);
}

/**
 * A video track showing only `region` of `track`. Driven by the frames
 * themselves, not timers, so it keeps going while the chat is in the
 * background. Stopping `track` ends it.
 */
export function croppedTrack(track: MediaStreamTrack, region: Rect): MediaStreamTrack {
	const api = globalThis as TransformApi;
	if (api.MediaStreamTrackProcessor === undefined || api.MediaStreamTrackGenerator === undefined) throw new Error("cropping a recording is not supported");
	const processor = new api.MediaStreamTrackProcessor({ track });
	const generator = new api.MediaStreamTrackGenerator({ kind: "video" });
	// The region is drawn onto its own canvas: encoders (Chrome's MP4) ignore a frame's visibleRect and record black.
	const canvas = new OffscreenCanvas(region.width, region.height);
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("no 2d canvas");
	const crop = new TransformStream<VideoFrame, VideoFrame>({
		transform(frame, controller) {
			try {
				// A window shared and then resized: keep the region inside the frame.
				const inside = evenRect(region, frame.displayWidth, frame.displayHeight);
				context.clearRect(0, 0, canvas.width, canvas.height);
				context.drawImage(frame, inside.x, inside.y, inside.width, inside.height, 0, 0, inside.width, inside.height);
				controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp }));
			} finally {
				frame.close();
			}
		},
	});
	void processor.readable
		.pipeThrough(crop)
		.pipeTo(generator.writable)
		.catch(() => undefined);
	return generator;
}

/** The container to record a screen into; "" lets the browser choose. */
export function recordingType(): string {
	if (typeof MediaRecorder.isTypeSupported !== "function") return "";
	return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

/** The recorded chunks as a file for the tray, typed by container without codecs (the tray sends video/mp4 and video/webm as videos). */
export function recordingFile(chunks: readonly Blob[], mimeType: string, at = new Date()): File {
	const type = (mimeType.split(";")[0] ?? "").trim() || "video/webm";
	const ext = type === "video/mp4" ? "mp4" : "webm";
	return new File([...chunks], captureName("screen-recording", ext, at), { type });
}
