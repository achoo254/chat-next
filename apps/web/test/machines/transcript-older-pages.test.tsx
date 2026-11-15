// A long session opens on its newest items only: the machine keeps the older
// ones until the user reaches the top of what is loaded, then sends them a
// page at a time. The transcript asks once per reach, says it is loading, and
// stops asking once everything is in. Folded earlier conversations (after a
// /clear) are only paged once the user opens them.
import { create } from "@bufbuild/protobuf";
import { ThreadState, ThreadSummarySchema } from "@achoo254/chat-proto/remote/remote";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { keepReading, markReading, Transcript } from "../../src/machines/session-chat.tsx";
import type { Block } from "../../src/machines/transcript/tool-fold.ts";

afterEach(cleanup);

const wrap = (node: ReactNode) => <I18nProvider>{node}</I18nProvider>;
const state = { info: null, full: new Map(), journals: new Map(), threads: [] } as unknown as LinkState;
const link = { activity: () => undefined, onActivity: () => () => undefined, request: () => Promise.reject(new Error("not used")) };
const thread = create(ThreadSummarySchema, { id: "t1", title: "Build", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: 1n });
const replies = (from: number, n: number): Block[] => Array.from({ length: n }, (_, i): Block => ({ kind: "text", id: `a${from + i}`, text: `reply ${from + i}`, partial: false }));

function view(blocks: readonly Block[], older: boolean, loadOlder: () => Promise<void>) {
	return wrap(
		<Transcript blocks={blocks} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live older={older} loadOlder={loadOlder} />,
	);
}

describe("older items of a long session", () => {
	it("asks the machine for the page before the loaded items, once, and shows it above", async () => {
		let finish: () => void = () => undefined;
		const loadOlder = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const shown = render(view(replies(10, 3), true, loadOlder));
		const button = screen.getByRole("button", { name: "Tải nội dung cũ hơn" });
		await act(async () => button.click());
		expect(loadOlder).toHaveBeenCalledTimes(1);
		const busy = screen.getByRole("button", { name: "Đang tải nội dung cũ hơn…" });
		expect((busy as HTMLButtonElement).disabled).toBe(true);
		await act(async () => busy.click());
		expect(loadOlder).toHaveBeenCalledTimes(1);

		// The page came in and nothing older is left on the machine.
		shown.rerender(view([...replies(0, 10), ...replies(10, 3)], false, loadOlder));
		await act(async () => finish());
		expect(screen.getByText("reply 0").compareDocumentPosition(screen.getByText("reply 10")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Tải nội dung cũ hơn" })).toBeNull();
	});

	it("draws loaded blocks first: the machine is asked only at the top of what is loaded", () => {
		render(view(replies(0, 100), true, vi.fn(() => Promise.resolve())));
		expect(screen.queryByRole("button", { name: "Tải nội dung cũ hơn" })).toBeNull();
		expect(screen.getByRole("button", { name: /^Xem \d+ mục trước$/ })).toBeTruthy();
	});

	it("does not page into a folded earlier conversation", () => {
		const loadOlder = vi.fn(() => Promise.resolve());
		render(
			wrap(
				<Transcript
					blocks={replies(10, 2)}
					previous={{ blocks: replies(0, 2), messages: 2, breakId: "conversation-break:1:s" }}
					state={state}
					running={false}
					startedAt={null}
					waiting={false}
					fetchFull={() => Promise.resolve()}
					link={link}
					threadId="t1"
					thread={thread}
					live
					older
					loadOlder={loadOlder}
				/>,
			),
		);
		expect(screen.queryByRole("button", { name: "Tải nội dung cũ hơn" })).toBeNull();
	});

	it("paging into the earlier conversation keeps the place being read, with that conversation folded and not counted yet", async () => {
		const breakId = "conversation-break:1:s";
		const current = replies(100, 3);
		const at = (previous: { blocks: Block[]; messages: number | null; breakId: string } | null, older: boolean) =>
			wrap(
				<Transcript
					blocks={current}
					previous={previous}
					breakId={breakId}
					state={state}
					running={false}
					startedAt={null}
					waiting={false}
					fetchFull={() => Promise.resolve()}
					link={link}
					threadId="t1"
					thread={thread}
					live
					older={older}
					loadOlder={() => Promise.resolve()}
				/>,
			);
		const shown = render(at(null, true));
		const scroller = shown.container.querySelector<HTMLDivElement>(".mx-messages");
		if (scroller === null) throw new Error("no scroller");
		// The user scrolled up to read: the transcript stops following.
		scroller.scrollTop = 0;
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
		await act(async () => scroller.dispatchEvent(new Event("scroll")));
		shown.rerender(at({ blocks: replies(0, 3), messages: null, breakId }, true));
		expect(scroller.scrollTop).toBe(0);
		expect(screen.getByRole("button", { name: "Cuộc trò chuyện trước" })).toBeTruthy();
		expect(screen.queryByText("reply 100")).toBeTruthy();
	});

	it("a burst of scroll events before a render still draws earlier blocks, and later reaches of the top keep working", async () => {
		const shown = render(view(replies(0, 130), false, () => Promise.resolve()));
		const scroller = shown.container.querySelector<HTMLDivElement>(".mx-messages");
		if (scroller === null) throw new Error("no scroller");
		let top = 5000;
		Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 6000 });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
		const scrollTo = (v: number) => {
			top = v;
			scroller.dispatchEvent(new Event("scroll"));
		};
		const drawn = () => shown.container.querySelectorAll(".mx-messages > *").length;
		await act(async () => scrollTo(4000));
		const before = drawn();
		// Two events in one batch: the second one's handler still sees the window as the first found it.
		await act(async () => {
			scrollTo(200);
			scrollTo(0);
		});
		expect(drawn()).toBeGreaterThan(before);
		const after = drawn();
		await act(async () => {
			scrollTo(300);
			scrollTo(0);
		});
		expect(drawn()).toBeGreaterThan(after);
	});

	it("keeps the block being read in place when older blocks come in above, the first one is drawn anew and new ones come at the bottom", () => {
		// A scroller laid out by hand: each block 100px tall, stacked from the scroller's top minus scrollTop.
		const scroller = document.createElement("div");
		let top = 0;
		Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
		const layout = () => {
			[...scroller.children].forEach((child, i) => {
				child.getBoundingClientRect = () => ({ top: i * 100 - top, bottom: i * 100 + 100 - top }) as DOMRect;
			});
			Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scroller.children.length * 100 });
		};
		scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
		const block = (name: string) => Object.assign(document.createElement("div"), { textContent: name });
		const button = Object.assign(document.createElement("button"), { textContent: "older" });
		button.setAttribute("data-id", "transcript-older");
		scroller.append(button, block("b10"), block("b11"), block("b12"));
		top = 30;
		layout();
		const mark = markReading(scroller);
		// Not the first block: a run of tools there folds into older tools that load above it.
		expect(mark.node?.textContent).toBe("b11");
		// The first block is drawn anew (folded with older tools), five older blocks above, two new ones at the bottom.
		const first = scroller.children[1];
		if (first === undefined) throw new Error("no first block");
		scroller.replaceChild(block("b10'"), first);
		scroller.insertBefore(block("b5"), scroller.children[1] ?? null);
		for (const n of ["b6", "b7", "b8", "b9"]) scroller.insertBefore(block(n), scroller.children[scroller.children.length - 3] ?? null);
		scroller.append(block("b13"), block("b14"));
		layout();
		keepReading(scroller, mark);
		layout();
		const reading = [...scroller.children].find((c) => c.textContent === "b11");
		expect(reading?.getBoundingClientRect().top).toBe(170);
	});

	it("scrolling on while an older page loads keeps the latest place, not the one where loading began", async () => {
		let finish: () => void = () => undefined;
		const loadOlder = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const shown = render(view(replies(10, 3), true, loadOlder));
		const scroller = shown.container.querySelector<HTMLDivElement>(".mx-messages");
		if (scroller === null) throw new Error("no scroller");
		let top = 900;
		Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scroller.children.length * 100 });
		// Laid out at call time: each child of the transcript 100px tall, in its current order.
		const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this === scroller) return { top: 0, bottom: 500 } as DOMRect;
			const i = this.parentElement === scroller ? [...scroller.children].indexOf(this) : 0;
			return { top: i * 100 - top, bottom: i * 100 + 100 - top } as DOMRect;
		});
		try {
			const scrollTo = (v: number) => {
				top = v;
				scroller.dispatchEvent(new Event("scroll"));
			};
			await act(async () => scrollTo(900));
			await act(async () => scrollTo(200));
			expect(loadOlder).toHaveBeenCalledTimes(1);
			// The fling goes on to the top before the page comes in.
			await act(async () => scrollTo(0));
			const reading = [...scroller.children].find((c) => c.textContent === "reply 10");
			const before = reading?.getBoundingClientRect().top;
			shown.rerender(view([...replies(7, 3), ...replies(10, 3)], false, loadOlder));
			await act(async () => finish());
			expect(reading?.getBoundingClientRect().top).toBe(before);
		} finally {
			rect.mockRestore();
		}
	});
});

