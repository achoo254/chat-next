// State shared between the first chunk (composer, conversation, message
// list) and the lazily loaded media screens: files waiting in the composer,
// the photo or video open in the viewer, and the topic of media sends still
// in the outbox (a pending message does not carry its topic).
import { Cell } from "../ui/ui-context.tsx";

/** A message whose photo or video is open in the viewer. */
export interface ViewerTarget {
	readonly chatId: number;
	readonly seq: number;
}

export const viewer = new Cell<ViewerTarget | null>(null);

const attached = new Map<string, Cell<readonly File[]>>();

/** Files picked, dropped or pasted into a chat's (or topic's) composer, not sent yet. */
export function attachments(chatId: number, topicId: number): Cell<readonly File[]> {
	const key = `${chatId}:${topicId}`;
	let cell = attached.get(key);
	if (cell === undefined) {
		cell = new Cell<readonly File[]>([]);
		attached.set(key, cell);
	}
	return cell;
}

export function addAttachments(chatId: number, topicId: number, files: readonly File[]): void {
	if (files.length === 0) return;
	const cell = attachments(chatId, topicId);
	cell.set([...cell.get(), ...files]);
}

/** random_id of a media send → its forum topic, so topic views show it while it uploads. */
export const pendingTopics = new Map<number, number>();

/** Whether a drag carries files (not text or a link dragged from the page). */
export function dragHasFiles(types: readonly string[]): boolean {
	return types.includes("Files");
}

const asFilesCells = new Map<string, Cell<boolean>>();

/** "Gửi dạng file": the composer's photos and videos go uncompressed, as files. */
export function sendAsFiles(chatId: number, topicId: number): Cell<boolean> {
	const key = `${chatId}:${topicId}`;
	let cell = asFilesCells.get(key);
	if (cell === undefined) {
		cell = new Cell(false);
		asFilesCells.set(key, cell);
	}
	return cell;
}

/** Forgets every chat's waiting files and pending topics (a new session in the same page, tests). */
export function resetMediaState(): void {
	attached.clear();
	asFilesCells.clear();
	pendingTopics.clear();
	viewer.set(null);
}
