// Hooks of the media screens: files of messages (from the media cache or
// downloaded through short-lived URLs, which the core refreshes on its
// own), the local file and progress of an upload, and whether a picture is
// near the viewport (pictures load lazily).
import { EventKeys, toBase64, type MediaRequest, type MediaSizeType, type UploadProgress } from "@app/core";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../data/services.tsx";

export type FileState =
	| { readonly status: "loading" }
	| { readonly status: "ok"; readonly url: string }
	/** The message was deleted for everyone or is no longer visible. */
	| { readonly status: "gone" }
	| { readonly status: "failed" };

const LOADING: FileState = { status: "loading" };

function requestKey(request: MediaRequest): string {
	return `${request.chatId}:${request.seq}:${request.fileId}:${request.size ?? "original"}`;
}

/**
 * An object URL of a message's file (or rendition) once `enabled`; the URL
 * is revoked when the request changes or the component goes away. `retry`
 * asks again after a failure.
 */
export function useMediaFile(request: MediaRequest | null, enabled = true): { readonly state: FileState; readonly retry: () => void } {
	const { source, store } = useServices();
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ readonly key: string; readonly state: FileState } | null>(null);
	const key = request === null ? "" : `${requestKey(request)}#${attempt}`;
	const chatId = request?.chatId ?? 0;
	const seq = request?.seq ?? 0;
	const fileId = request?.fileId ?? "";
	const size: MediaSizeType | undefined = request?.size;
	const kind = request?.kind;
	useEffect(() => {
		if (key === "" || !enabled) return;
		let active = true;
		let url: string | null = null;
		const wanted: MediaRequest = { chatId, seq, fileId, ...(size === undefined ? {} : { size }), ...(kind === undefined ? {} : { kind }) };
		source.mediaFile(wanted).then(
			(file) => {
				if (!active) return;
				if (file.status === "unavailable") {
					setResult({ key, state: { status: "gone" } });
					return;
				}
				url = URL.createObjectURL(file.blob);
				setResult({ key, state: { status: "ok", url } });
			},
			(err: unknown) => {
				store.reportError(err, `media ${chatId}:${seq}`);
				if (active) setResult({ key, state: { status: "failed" } });
			},
		);
		return () => {
			active = false;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [source, store, key, enabled, chatId, seq, fileId, size, kind]);
	const retry = useCallback(() => setAttempt((n) => n + 1), []);
	const state = result !== null && result.key === key ? result.state : LOADING;
	return { state, retry };
}

/** An object URL of a pending upload's local file (photos show before they are uploaded). */
export function usePendingFileUrl(uploadKey: string, enabled: boolean): string | null {
	const { source, store } = useServices();
	const [result, setResult] = useState<{ readonly key: string; readonly url: string | null } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		let url: string | null = null;
		source.pendingFile(uploadKey).then(
			(blob) => {
				if (!active) return;
				url = blob === null ? null : URL.createObjectURL(blob);
				setResult({ key: uploadKey, url });
			},
			(err: unknown) => store.reportError(err, `pending file ${uploadKey}`),
		);
		return () => {
			active = false;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [source, store, uploadKey, enabled]);
	return result !== null && result.key === uploadKey ? result.url : null;
}

/** Upload state of a pending media send, following its EventKeys.upload events. */
export function useUploadProgress(uploadKey: string): UploadProgress | null {
	const { source, store } = useServices();
	const [result, setResult] = useState<{ readonly key: string; readonly progress: UploadProgress | null } | null>(null);
	useEffect(() => {
		let active = true;
		let serial = 0;
		let shown = 0;
		const read = () => {
			const mine = ++serial;
			source.uploadProgress(uploadKey).then(
				(progress) => {
					// Answers can overtake each other: keep the newest read.
					if (!active || mine < shown) return;
					shown = mine;
					setResult({ key: uploadKey, progress });
				},
				(err: unknown) => store.reportError(err, `upload ${uploadKey}`),
			);
		};
		read();
		const stop = source.events.subscribe(EventKeys.upload(uploadKey), read);
		return () => {
			active = false;
			stop();
		};
	}, [source, store, uploadKey]);
	return result !== null && result.key === uploadKey ? result.progress : null;
}

/**
 * A ref for an element and whether it is near the viewport (pictures load
 * when they are about to show). Without IntersectionObserver it is always
 * near.
 */
export function useNearViewport(): [(element: Element | null) => (() => void) | undefined, boolean] {
	const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
	const ref = useCallback((element: Element | null) => {
		if (element === null || typeof IntersectionObserver === "undefined") return undefined;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setNear(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "400px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, near];
}

/** The inline thumbnail (a JPEG of a few hundred bytes) as a data URL; "" when there is none. */
export function inlineThumbUrl(bytes: Uint8Array): string {
	return bytes.length === 0 ? "" : `data:image/jpeg;base64,${toBase64(bytes)}`;
}
