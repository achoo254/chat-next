// State of the compact window: the open picture-in-picture window, or null.
// Small external store read with useSyncExternalStore; the picture-in-picture
// module does the browser work.
import { useSyncExternalStore } from "react";
import { isPictureInPictureSupported, openPictureInPicture, type WindowSize } from "./pip-window.ts";

export const DEFAULT_SIZE: WindowSize = { width: 380, height: 560 };
const MIN_SIDE = 240;
const SIZE_KEY = "compact-window-size";

/** Size of the last compact window; the default when nothing usable is saved or storage is unavailable. */
export function readSavedSize(): WindowSize {
	try {
		const raw = window.localStorage.getItem(SIZE_KEY);
		if (raw === null) return DEFAULT_SIZE;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_SIZE;
		const { width, height } = parsed as { width?: unknown; height?: unknown };
		if (typeof width !== "number" || typeof height !== "number") return DEFAULT_SIZE;
		if (!(width >= MIN_SIDE) || !(height >= MIN_SIDE)) return DEFAULT_SIZE;
		return { width: Math.round(width), height: Math.round(height) };
	} catch {
		return DEFAULT_SIZE;
	}
}

function saveSize(size: WindowSize): void {
	try {
		window.localStorage.setItem(SIZE_KEY, JSON.stringify(size));
	} catch {
		// Private window or blocked storage: the next window opens at the default size.
	}
}

/** A window's frame (title bar, borders) is about this much; a bigger difference is not a frame. */
const MAX_FRAME = 120;
/** How long after opening the browser may still resize the window to fit its frame. */
const SETTLE_MS = 1000;

/**
 * What the browser takes off the requested size: Chromium makes the window's
 * inner size smaller than asked by its title bar. The size to ask for next
 * time is the inner size plus this, or each opening would shrink the window.
 */
function frameOf(requested: WindowSize, pip: Window): WindowSize {
	const part = (asked: number, got: number): number => {
		const difference = asked - got;
		return got > 0 && difference > 0 && difference <= MAX_FRAME ? difference : 0;
	};
	return { width: part(requested.width, pip.innerWidth), height: part(requested.height, pip.innerHeight) };
}

type Listener = () => void;

class CompactWindowStore {
	private current: Window | null = null;
	private opening = false;
	private stopMirroring: (() => void) | null = null;
	private readonly listeners = new Set<Listener>();

	subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** The open window, or null. */
	get = (): Window | null => this.current;

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}

	/** Opens the window, or focuses the one already open. Call from a user gesture. */
	async open(): Promise<void> {
		if (this.current !== null) {
			this.current.focus();
			return;
		}
		if (this.opening) return;
		this.opening = true;
		try {
			const requested = readSavedSize();
			const opened = await openPictureInPicture(requested);
			if (opened === null) return;
			const pip = opened.window;
			this.stopMirroring = opened.stopMirroring;
			const openedAt = Date.now();
			let frame = frameOf(requested, pip);
			// The window is gone for any reason (its close button, the page closing): drop it.
			pip.addEventListener("pagehide", () => this.release(pip));
			pip.addEventListener("resize", () => {
				// Resizes just after opening are the browser fitting the window to its frame, not the user.
				if (Date.now() - openedAt < SETTLE_MS) {
					frame = frameOf(requested, pip);
					return;
				}
				saveSize({ width: pip.innerWidth + frame.width, height: pip.innerHeight + frame.height });
			});
			this.current = pip;
			this.emit();
		} finally {
			this.opening = false;
		}
	}

	close(): void {
		this.current?.close();
	}

	private release(pip: Window): void {
		if (this.current !== pip) return;
		this.stopMirroring?.();
		this.stopMirroring = null;
		this.current = null;
		this.emit();
	}
}

export const compactWindow = new CompactWindowStore();

/** The compact window while it is open, else null. */
export function useCompactWindow(): Window | null {
	return useSyncExternalStore(compactWindow.subscribe, compactWindow.get);
}

export { isPictureInPictureSupported };
