// Long-lived services of the messaging UI. The object never changes after
// start-up, so a context is fine for it; everything that changes often is
// read from ChatStore through the hooks below (useSyncExternalStore per key).
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import type { Chat, ConnectionState, DialogView, StoredMessage, User } from "@app/core";
import type { SelfUser } from "../../api/adapters.ts";
import type { Drafts } from "./drafts.ts";
import type { Folder } from "./format.ts";
import type { PendingBackend, Topic } from "./pending-backend.ts";
import type { Remote } from "./remote.ts";
import type { ChatSource } from "./source.ts";
import type { ChatStore, ChatWindow, ListStatus, WindowItem } from "./store.ts";

/** Short confirmation shown at the bottom of the screen (mockups: .toast). */
export class Toasts {
	private text = "";
	private serial = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly listeners = new Set<() => void>();

	show(text: string): void {
		this.text = text;
		this.serial++;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.text = "";
			this.emit();
		}, 2400);
		this.emit();
	}

	current(): string {
		return this.text;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export interface Services {
	readonly self: SelfUser;
	readonly source: ChatSource;
	readonly store: ChatStore;
	readonly remote: Remote;
	readonly backend: PendingBackend;
	readonly toasts: Toasts;
	readonly drafts: Drafts;
	/** Wipes local data and ends the session. */
	signOut(): void;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
	const services = useContext(ServicesContext);
	if (services === null) throw new Error("useServices must be used inside <ServicesContext>");
	return services;
}

function useStoreKey<T>(key: string, read: () => T): T {
	const { store } = useServices();
	const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key]);
	return useSyncExternalStore(subscribe, read);
}

export function useDialogOrder(): readonly number[] {
	const { store } = useServices();
	return useStoreKey("list", () => store.listSnapshot());
}

export function useFolderCounts(): Readonly<Record<Folder, number>> {
	const { store } = useServices();
	return useStoreKey("folders", () => store.folderCounts());
}

export function useListStatus(): ListStatus {
	const { store } = useServices();
	return useStoreKey("list", () => store.listState());
}

export function useDialog(chatId: number): DialogView | undefined {
	const { store } = useServices();
	return useStoreKey(`dialog:${chatId}`, () => store.dialog(chatId));
}

/** The chat, loading it when it is not in the dialog list (just joined, opened by link). */
export function useChat(chatId: number): Chat | null | undefined {
	const { store } = useServices();
	useDialog(chatId);
	const chat = useStoreKey(`chat:${chatId}`, () => store.chat(chatId));
	useEffect(() => {
		if (chatId !== 0) store.ensureChat(chatId);
	}, [store, chatId]);
	return chat;
}

export function useUser(userId: number): User | undefined {
	const { store } = useServices();
	const user = useStoreKey(`user:${userId}`, () => store.user(userId));
	useEffect(() => {
		if (user === undefined && userId !== 0) store.wantUser(userId);
	}, [store, user, userId]);
	return user;
}

export function useConnection(): ConnectionState {
	const { store } = useServices();
	return useStoreKey("connection", () => store.connectionState());
}

export function useWindow(chatId: number): ChatWindow | undefined {
	const { store } = useServices();
	return useStoreKey(`window:${chatId}`, () => store.window(chatId));
}

export function useItem(chatId: number, key: string): WindowItem | undefined {
	const { store } = useServices();
	return useStoreKey(`item:${chatId}:${key}`, () => store.item(chatId, key));
}

/** A single message (reply quote, pinned bar); loaded on demand. */
export function useMessage(chatId: number, seq: number): StoredMessage | null | undefined {
	const { store } = useServices();
	useWindow(chatId);
	const message = useStoreKey(`lookup:${chatId}:${seq}`, () => (seq === 0 ? null : store.message(chatId, seq)));
	useEffect(() => {
		if (message === undefined && seq !== 0) store.wantMessage(chatId, seq);
	}, [store, message, chatId, seq]);
	return message;
}

/** Re-renders when state kept by the pending backend (topics, mute) changes. */
export function useBackendVersion(): number {
	const { backend } = useServices();
	const subscribe = useCallback((listener: () => void) => backend.subscribe(listener), [backend]);
	return useSyncExternalStore(subscribe, () => backend.version());
}

export function useToast(): string {
	const { toasts } = useServices();
	const subscribe = useCallback((listener: () => void) => toasts.subscribe(listener), [toasts]);
	return useSyncExternalStore(subscribe, () => toasts.current());
}

/** The saved draft of a chat (any topic of it re-renders the row). */
export function useDraft(chatId: number, topicId = 0): string {
	const { drafts } = useServices();
	const subscribe = useCallback((listener: () => void) => drafts.subscribe(chatId, listener), [drafts, chatId]);
	return useSyncExternalStore(subscribe, () => drafts.get(chatId, topicId));
}

/** Topics of a forum group (null for any other chat), loaded on demand. */
export function useTopics(chatId: number, forum: boolean): readonly Topic[] | null {
	const { backend } = useServices();
	useBackendVersion();
	const enabled = forum && backend.features.has("topics");
	useEffect(() => {
		if (enabled) backend.loadTopics(chatId);
	}, [backend, chatId, enabled]);
	return enabled ? backend.topics(chatId) : null;
}
