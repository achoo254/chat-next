// Perf page of the visual harness: the real app and client core against the
// core's in-memory server, seeded at the speed-budget sizes (1,000 chats, a
// 5,000-message chat), with the scenarios of the perf gate on
// window.perfHarness (see test/perf/perf-api.ts). Test-only: never part of the
// production build. The client core runs on this page's main thread (the
// production app runs it in a worker), so the numbers are pessimistic.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { createRouterTransport } from "@connectrpc/connect";
import { openMemoryFactory } from "../../../../packages/platform-web/src/driver.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/app.tsx";
import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";
import type { MessagingConnector } from "../../src/messaging/data/connector.ts";
import type { ChatSource } from "../../src/messaging/data/source.ts";
import { PERF_SEED, type OpenSample, type PerfHarness, type ScrollSample } from "../perf/perf-api.ts";
import { ChatFixture, fixtureConnector } from "../support/fake-chat.ts";

const TIMEOUT_MS = 60_000;
const PEOPLE = 40;
const CACHED_CHAT_MESSAGES = 80;

const WORDS =
	"triển khai máy chủ cấu hình kiểm tra phiên bản dữ liệu nhật ký cảnh báo sự cố khắc phục bản vá lịch họp tài liệu giao diện đăng nhập tìm kiếm hiệu năng bộ nhớ".split(
		" ",
	);

/** Deterministic message text of 3 to 60 words; every ninth one spans lines. */
function text(index: number): string {
	const length = 3 + ((index * 7919) % 58);
	const words: string[] = [];
	for (let word = 0; word < length; word++) words.push(WORDS[(index + word * 13) % WORDS.length] ?? "");
	const line = words.join(" ");
	return index % 9 === 0 ? `${line}\n${words.slice(0, 6).join(" ")}` : line;
}

interface Seed {
	readonly fixture: ChatFixture;
	readonly longChat: number;
	readonly cached: readonly { id: number; title: string }[];
}

function seed(): Seed {
	const f = new ChatFixture();
	const me = f.selfId;
	const people: number[] = [];
	for (let index = 0; index < PEOPLE; index++) people.push(f.addUser(`Người dùng ${index + 1}`));
	const member = (index: number) => people[index % PEOPLE] ?? me;
	const markRead = (chatId: number) => f.server.readHistory(me, chatId, Math.max(...f.server.messageSeqs(chatId)));

	// Three pinned chats sit on top of the list: the long chat and two more to switch between.
	const fillers = PERF_SEED.chats - 3;
	for (let index = 0; index < fillers; index++) {
		const chatId =
			index < PEOPLE
				? f.createChat(ChatType.PRIVATE, "", [me, member(index)])
				: f.createChat(ChatType.GROUP, `Nhóm ${String(index + 1).padStart(4, "0")}`, [me, member(index), member(index + 1)]);
		f.server.sendMessage(member(index), chatId, text(index));
		if (index % 4 !== 0) markRead(chatId);
	}

	const group = (title: string) => f.createChat(ChatType.GROUP, title, [me, ...people.slice(0, 6)], { myRole: MemberRole.MEMBER });
	const longChat = group("Lịch sử dài");
	for (let index = 0; index < PERF_SEED.longChatMessages; index++) {
		f.server.sendMessage(index % 5 === 0 ? me : member(index % 6), longChat, text(index));
	}
	markRead(longChat);
	const cached = [
		{ id: longChat, title: "Lịch sử dài" },
		{ id: group("Phòng A"), title: "Phòng A" },
		{ id: group("Phòng B"), title: "Phòng B" },
	];
	for (const chat of cached.slice(1)) {
		for (let index = 0; index < CACHED_CHAT_MESSAGES; index++) f.server.sendMessage(member(index % 6), chat.id, text(index + chat.id));
		markRead(chat.id);
	}
	return { fixture: f, longChat, cached };
}

// ------------------------------------------------------------- measuring

function nextFrame(): Promise<number> {
	return new Promise((resolve) => requestAnimationFrame(resolve));
}

function until<T>(test: () => T | null | undefined, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const poll = () => {
			const found = test();
			if (found !== null && found !== undefined) resolve(found);
			else if (performance.now() - started > TIMEOUT_MS) reject(new Error(`perf: timed out waiting for ${what}`));
			else setTimeout(poll, 20);
		};
		poll();
	});
}

/** Collects long tasks (main-thread tasks over 50 ms) until stopped. */
function watchLongTasks(): () => number[] {
	const durations: number[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) durations.push(entry.duration);
	});
	observer.observe({ type: "longtask" });
	return () => {
		for (const entry of observer.takeRecords()) durations.push(entry.duration);
		observer.disconnect();
		return durations;
	};
}

/**
 * Resolves once the main thread has been idle for `quietMs`: the in-page core
 * finishes its start-up sync and indexing (small tasks, not only long ones)
 * before the scenarios run. In production that work runs in the client worker.
 */
function settle(quietMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		let idleSince = started;
		const check = (deadline: IdleDeadline) => {
			const now = performance.now();
			// A full idle period (up to 50 ms) means nothing else was queued.
			if (deadline.timeRemaining() < 40) idleSince = now;
			if (now - idleSince >= quietMs) resolve();
			else if (now - started > TIMEOUT_MS) reject(new Error("perf: the page never went quiet"));
			else requestIdleCallback(check);
		};
		requestIdleCallback(check);
	});
}

function chatList(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".chats");
}

/** The conversation shows `title` and its messages (not the loading state). */
function chatShown(title: string): boolean {
	const head = document.querySelector(".convo-head");
	const messages = document.querySelector(".messages");
	return (
		head?.textContent?.includes(title) === true &&
		messages !== null &&
		messages.getAttribute("aria-busy") !== "true" &&
		messages.querySelector("[data-key]") !== null
	);
}

/**
 * Clicks the chat's row and resolves with the time to the first frame that
 * shows its messages: a DOM observer notices the commit, then the next
 * animation frame plus a task marks the frame as produced.
 */
function openChat(chatId: number, title: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const row = document.querySelector<HTMLElement>(`.chats a.chat-row[href="/c/${chatId}"]`);
		if (row === null) {
			reject(new Error(`perf: no row for chat ${chatId}`));
			return;
		}
		const timer = setTimeout(() => {
			observer.disconnect();
			reject(new Error(`perf: chat ${chatId} did not open`));
		}, TIMEOUT_MS);
		const observer = new MutationObserver(() => {
			if (!chatShown(title)) return;
			observer.disconnect();
			clearTimeout(timer);
			requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - started)));
		});
		observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
		const started = performance.now();
		row.click();
	});
}

/** Moves `element` by `step` px per frame until `done`, recording frame timestamps. */
async function scrollFrames(
	element: HTMLElement,
	step: number,
	done: () => boolean,
	progress: () => string,
): Promise<{ frames: number[]; longTasks: number[] }> {
	const stop = watchLongTasks();
	const frames: number[] = [await nextFrame()];
	const started = performance.now();
	while (!done()) {
		if (performance.now() - started > TIMEOUT_MS) {
			stop();
			throw new Error(`perf: scroll did not reach its end (${progress()})`);
		}
		element.scrollTop += step;
		frames.push(await nextFrame());
	}
	return { frames, longTasks: stop() };
}

function oldestSeq(messages: HTMLElement): number {
	const first = messages.querySelector<HTMLElement>("[data-seq]");
	return Number(first?.dataset.seq ?? Number.NaN);
}

/** Scrolling up has brought message `seq` into view, or the window already slid past it. */
function reached(messages: HTMLElement, seq: number): boolean {
	const target = messages.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
	if (target === null) return oldestSeq(messages) < seq;
	return target.offsetTop + target.offsetHeight >= messages.scrollTop;
}

const data = seed();
let chatSource: ChatSource | null = null;

/** Loads the newest `messages` of a chat into the client cache, as an earlier visit would. */
async function warmHistory(chatId: number, messages: number): Promise<void> {
	const source = await until(() => chatSource, "the client core");
	let offsetSeq = 0;
	let loaded = 0;
	while (loaded < messages) {
		const page = await source.history(chatId, { direction: "older", offsetSeq, limit: 200 });
		const oldest = page.messages[0]?.seq;
		if (oldest === undefined) break;
		loaded += page.messages.length;
		offsetSeq = oldest;
	}
}

const harness: PerfHarness = {
	async ready() {
		const first = await until(() => chatList()?.querySelector<HTMLElement>("li.chat-slot"), "the chat list");
		await settle(1_500);
		return { chats: Number(first.getAttribute("aria-setsize") ?? 0) };
	},

	async openCachedChats(rounds): Promise<OpenSample> {
		// Cached: the newest messages are in the client cache and each chat was open once.
		for (const chat of data.cached) await warmHistory(chat.id, 200);
		for (const chat of data.cached) {
			await openChat(chat.id, chat.title);
			// Let the window's history load settle before the next switch.
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const stop = watchLongTasks();
		const openMs: number[] = [];
		for (let round = 0; round < rounds; round++) {
			for (const chat of data.cached) {
				openMs.push(await openChat(chat.id, chat.title));
				await nextFrame();
			}
		}
		return { openMs, longTasks: stop() };
	},

	async scrollChatList(stepPx): Promise<ScrollSample> {
		const list = await until(chatList, "the chat list");
		list.scrollTop = 0;
		await nextFrame();
		const end = () => list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
		const sample = await scrollFrames(list, stepPx, end, () => `scrollTop ${list.scrollTop} of ${list.scrollHeight}`);
		const rows = Number(list.querySelector("li.chat-slot")?.getAttribute("aria-setsize") ?? 0);
		return { ...sample, travelled: Math.round((list.scrollTop + list.clientHeight) / (list.scrollHeight / Math.max(1, rows))) };
	},

	async scrollHistory(messages, stepPx): Promise<ScrollSample> {
		// Measure scrolling cached history; the first fetch from the server
		// would run the harness's in-page core and SQLite on the main thread.
		await warmHistory(data.longChat, messages + 200);
		const title = data.cached[0]?.title ?? "";
		if (!chatShown(title)) {
			// The pinned row is on top of the list, which the list scroll left at its end.
			const rows = await until(chatList, "the chat list");
			rows.scrollTop = 0;
			await until(() => rows.querySelector(`a.chat-row[href="/c/${data.longChat}"]`), "the long chat's row");
			await openChat(data.longChat, title);
		}
		const list = await until(() => document.querySelector<HTMLElement>(".messages[role=log]"), "the message list");
		const newest = PERF_SEED.longChatMessages;
		// Start at the newest message (an earlier run left the view up in the history).
		document.querySelector<HTMLButtonElement>(".to-bottom")?.click();
		await until(() => (list.querySelector(`[data-seq="${newest}"]`) !== null && list.scrollHeight - list.scrollTop - list.clientHeight < 2 ? list : null), "the newest message");
		await settle(500);
		const target = newest - messages;
		const sample = await scrollFrames(
			list,
			-stepPx,
			() => reached(list, target),
			() => `oldest loaded message ${oldestSeq(list)}, target ${target}, scrollTop ${list.scrollTop}`,
		);
		return { ...sample, travelled: newest - oldestSeq(list) };
	},
};
window.perfHarness = harness;

// The app routes by path; the page itself is /perf.html.
window.history.replaceState(null, "", "/");
const container = document.getElementById("root");
if (container === null) throw new Error("perf page is missing #root");
const f = data.fixture;
const fixture = fixtureConnector(f, openMemoryFactory, { pinnedDialogs: new Set(data.cached.map((chat) => chat.id)) });
const connector: MessagingConnector = async (options) => {
	const client = await fixture(options);
	chatSource = client.source;
	return client;
};
createRoot(container).render(
	<StrictMode>
		<App
			transport={createRouterTransport((router) => f.routes(router))}
			messagingConnector={connector}
		/>
	</StrictMode>,
);
