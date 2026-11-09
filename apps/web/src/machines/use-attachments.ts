// The files waiting in a session's composer: each one added (picked, pasted
// or dropped) is checked against the machine's limits, an image is fitted to
// what the AI takes, and the upload starts at once over the machine's link,
// so the message goes as soon as it is sent. A file can be removed (its
// upload is cancelled) or tried again. Sending takes the uploaded files; when
// the message fails they come back and upload again.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../messaging/media/media-format.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { fitImage } from "./attachment-image.ts";
import { admit, looksLikeImage, newUploadId, rememberPreview, UploadCancelled, uploadFile, type Limits, type Refusal, type UploadLink } from "./attachments.ts";
import { errorText } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import type { ShownAttachment } from "./transcript/tool-fold.ts";

export interface TrayItem {
	/** The upload id on the machine. */
	readonly id: string;
	readonly name: string;
	readonly size: number;
	/** Goes to the AI as an image (with a preview here). */
	readonly image: boolean;
	readonly preview: string;
	readonly state: "preparing" | "uploading" | "ready" | "failed";
	/** Bytes the machine has. */
	readonly sent: number;
	readonly error: string;
}

export interface Attachments {
	/** The machine takes files (tunelo 2.0.5+); when false, adding only says so. */
	readonly supported: boolean;
	readonly items: readonly TrayItem[];
	/** Why files were refused, in the user's language; "" when none. */
	readonly notice: string;
	/** Some file is still being fitted or uploaded. */
	readonly busy: boolean;
	/** Some upload failed: remove it or try again. */
	readonly failed: boolean;
	add(files: readonly File[]): void;
	remove(id: string): void;
	retry(id: string): void;
	dismiss(): void;
	/** The uploaded files, out of the tray, for a message about to go. */
	take(): ShownAttachment[];
	/** The message went: the thread keeps their previews. */
	sent(files: readonly ShownAttachment[]): void;
	/** The message failed: the files come back and upload again. */
	putBack(files: readonly ShownAttachment[]): void;
}

/** The size the limits count: an image the browser will shrink counts as at most the image limit. */
function plannedSize(file: File, image: boolean, limits: Limits): number {
	return image ? Math.min(file.size, limits.imageMaxBytes) : file.size;
}

export function useAttachments(link: UploadLink, threadId: string, limits: Limits | null, images: boolean, ai: string): Attachments {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const [items, setItems] = useState<readonly TrayItem[]>([]);
	const [notice, setNotice] = useState("");
	const files = useRef(new Map<string, File>());
	const aborts = useRef(new Map<string, AbortController>());
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		const held = files.current;
		const running = aborts.current;
		return () => {
			live.current = false;
			for (const controller of running.values()) controller.abort();
			running.clear();
			held.clear();
		};
	}, []);

	const patch = useCallback((id: string, change: Partial<TrayItem>) => {
		if (!live.current) return;
		setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
	}, []);

	const start = useCallback(
		(id: string, file: File) => {
			const controller = new AbortController();
			aborts.current.set(id, controller);
			patch(id, { state: "uploading", sent: 0, error: "" });
			uploadFile(link, {
				threadId,
				uploadId: id,
				file,
				pieceBytes: limits?.pieceMaxBytes ?? 512 * 1024,
				signal: controller.signal,
				onProgress: (sent) => patch(id, { sent }),
			}).then(
				() => {
					aborts.current.delete(id);
					patch(id, { state: "ready", sent: file.size });
				},
				(err: unknown) => {
					aborts.current.delete(id);
					if (err instanceof UploadCancelled) return;
					patch(id, { state: "failed", error: errorText(t, err, ai) });
				},
			);
		},
		[link, threadId, limits, patch, t, ai],
	);

	const refusalText = useCallback(
		(r: Refusal): string => {
			if (limits === null) return t.agent.attach.needsUpdate;
			switch (r.kind) {
				case "too-large":
					return t.agent.attach.tooLarge(r.name, formatBytes(limits.fileMaxBytes, locale));
				case "too-many":
					return t.agent.attach.tooMany(limits.messageMaxFiles);
				case "total-too-large":
					return t.agent.attach.totalTooLarge(formatBytes(limits.messageMaxBytes, locale));
			}
		},
		[limits, t, locale],
	);

	/** Fits an image, then uploads. */
	const prepare = useCallback(
		async (id: string, file: File, image: boolean) => {
			let out = file;
			let asImage = false;
			if (image && limits !== null) {
				const fitted = await fitImage(file, limits.imageMaxBytes).catch(() => undefined);
				if (fitted !== undefined) {
					out = fitted;
					asImage = true;
				}
			}
			if (!live.current || !files.current.has(id)) return;
			if (limits !== null && out.size > limits.fileMaxBytes) {
				patch(id, { state: "failed", error: t.agent.attach.tooLarge(file.name, formatBytes(limits.fileMaxBytes, locale)) });
				return;
			}
			files.current.set(id, out);
			patch(id, { name: out.name, size: out.size, image: asImage, preview: asImage ? URL.createObjectURL(out) : "" });
			start(id, out);
		},
		[limits, patch, start, t, locale],
	);

	const add = useCallback(
		(added: readonly File[]) => {
			if (added.length === 0) return;
			if (limits === null) {
				setNotice(t.agent.attach.needsUpdate);
				return;
			}
			const planned = added.map((file) => {
				const image = images && looksLikeImage(file);
				return { file, image, name: file.name || "file", size: plannedSize(file, image, limits) };
			});
			const { accepted, refused } = admit(items, planned, limits);
			setNotice(refused.map(refusalText).join(" "));
			const fresh = accepted.map((p): TrayItem => ({
				id: newUploadId(),
				name: p.name,
				size: p.file.size,
				image: p.image,
				preview: "",
				state: p.image ? "preparing" : "uploading",
				sent: 0,
				error: "",
			}));
			setItems((list) => [...list, ...fresh]);
			fresh.forEach((item, i) => {
				const p = accepted[i];
				if (p === undefined) return;
				files.current.set(item.id, p.file);
				void prepare(item.id, p.file, p.image);
			});
		},
		[limits, images, items, refusalText, prepare, t],
	);

	const remove = useCallback(
		(id: string) => {
			const running = aborts.current.get(id);
			const item = items.find((x) => x.id === id);
			if (running !== undefined) running.abort();
			else if (item?.state === "ready") link.request({ case: "attachmentCancel", value: { uploadId: id } }).catch(() => undefined);
			if (item !== undefined && item.preview !== "") URL.revokeObjectURL(item.preview);
			files.current.delete(id);
			setItems((list) => list.filter((x) => x.id !== id));
		},
		[items, link],
	);

	const retry = useCallback(
		(id: string) => {
			const file = files.current.get(id);
			if (file !== undefined) start(id, file);
		},
		[start],
	);

	const take = useCallback((): ShownAttachment[] => {
		const ready = items.filter((x) => x.state === "ready");
		setItems((list) => list.filter((x) => x.state !== "ready"));
		return ready.map((x) => ({ id: x.id, name: x.name, size: x.size, image: x.image, path: "", preview: x.preview }));
	}, [items]);

	const sent = useCallback(
		(done: readonly ShownAttachment[]) => {
			for (const f of done) {
				files.current.delete(f.id);
				if (f.image && f.preview !== "") rememberPreview(threadId, f.id, f.preview);
			}
		},
		[threadId],
	);

	const putBack = useCallback(
		(back: readonly ShownAttachment[]) => {
			const again = back.flatMap((f) => {
				const file = files.current.get(f.id);
				files.current.delete(f.id);
				if (file === undefined) return [];
				const id = newUploadId();
				files.current.set(id, file);
				return [{ item: { id, name: f.name, size: f.size, image: f.image, preview: f.preview, state: "uploading" as const, sent: 0, error: "" }, file }];
			});
			if (!live.current) return;
			setItems((list) => [...again.map((a) => a.item), ...list]);
			for (const a of again) start(a.item.id, a.file);
		},
		[start],
	);

	return useMemo(
		() => ({
			supported: limits !== null,
			items,
			notice,
			busy: items.some((x) => x.state === "preparing" || x.state === "uploading"),
			failed: items.some((x) => x.state === "failed"),
			add,
			remove,
			retry,
			dismiss: () => setNotice(""),
			take,
			sent,
			putBack,
		}),
		[limits, items, notice, add, remove, retry, take, sent, putBack],
	);
}
