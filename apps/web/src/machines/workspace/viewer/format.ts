// Sizes and times as the panel shows them.
import type { PanelCopy } from "../panel-copy-vi.ts";

/** Bytes as "512 B", "12.4 KB", "3.1 MB". */
export function formatSize(bytes: number, units: PanelCopy["units"]): string {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} ${units.b}`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${units.kb}`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} ${units.mb}`;
}

/** How long ago `at` (Unix ms) was, from `now`. */
export function timeAgo(at: number, now: number, time: PanelCopy["time"]): string {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return time.now;
	if (minutes < 60) return time.minutes(minutes);
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return time.hours(hours);
	return time.days(Math.floor(hours / 24));
}
