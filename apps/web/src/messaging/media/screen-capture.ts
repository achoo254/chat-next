// Screenshots and screen recordings as files for the composer's tray: one
// frame of the shared screen as a PNG, the recording's container chosen
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

/** Takes one frame of a shared screen as a PNG file, then stops sharing. */
export async function screenshotFile(stream: MediaStream, at = new Date()): Promise<File> {
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
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (blob === null) throw new Error("the screenshot could not be encoded");
		return new File([blob], captureName("screenshot", "png", at), { type: "image/png" });
	} finally {
		video.srcObject = null;
		stopStream(stream);
	}
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
