// The phone keyboard: the visible box the session and the terminal keep to
// (iOS slides the keyboard over the page; pinch zoom is not a keyboard), and
// the terminal's key row after Orca's: what each key sends (Shift+Tab, F-keys,
// Home/End in both cursor modes), Ctrl and Alt for one key or held, held
// keys repeating, and the row's order and names.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_MIN_PX, KEYBOARD_OPEN_CLASS, keyboardOcclusion, useViewportFit, viewportBox } from "../../src/machines/viewport-fit.ts";
import {
	afterKey,
	DOUBLE_TAP_MS,
	keySequence,
	MobileKeyBar,
	NO_MODIFIERS,
	repeatKey,
	REPEAT_DELAY_MS,
	REPEAT_INTERVAL_MS,
	tapLatch,
	withModifiers,
	type BarLabels,
} from "../../src/terminal/mobile-key-bar.tsx";
import { EMPTY_PREFS, rowOf } from "../../src/terminal/key-prefs.ts";

/** A visualViewport the test moves, as the keyboard would. */
class FakeViewport extends EventTarget {
	height = 844;
	offsetTop = 0;
	scale = 1;
	move(height: number, offsetTop = 0): void {
		this.height = height;
		this.offsetTop = offsetTop;
		this.dispatchEvent(new Event("resize"));
	}
}

afterEach(() => {
	vi.useRealTimers();
	Reflect.deleteProperty(window, "visualViewport");
	document.documentElement.classList.remove(KEYBOARD_OPEN_CLASS);
});

function installViewport(): FakeViewport {
	const viewport = new FakeViewport();
	Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
	return viewport;
}

describe("the visible box", () => {
	it("is what the keyboard leaves; small gaps and pinch zoom are not a keyboard", () => {
		expect(keyboardOcclusion({ height: 844, offsetTop: 0, scale: 1 }, 844)).toBe(0);
		// iOS: the keyboard slides over a page that stays 844 tall.
		expect(keyboardOcclusion({ height: 508, offsetTop: 0, scale: 1 }, 844)).toBe(336);
		// The page scrolled up under it: the hidden part is what lies below the visible box.
		expect(keyboardOcclusion({ height: 508, offsetTop: 120, scale: 1 }, 844)).toBe(216);
		expect(keyboardOcclusion({ height: 844 - KEYBOARD_MIN_PX + 1, offsetTop: 0, scale: 1 }, 844)).toBe(0);
		expect(keyboardOcclusion({ height: 400, offsetTop: 0, scale: 2 }, 844)).toBe(0);
		// Android with resizes-content: the page shrinks with the visible box, nothing is hidden.
		expect(keyboardOcclusion({ height: 508, offsetTop: 0, scale: 1 }, 508)).toBe(0);
	});

	it("without visualViewport it is the window", () => {
		expect(viewportBox()).toEqual({ height: window.innerHeight, top: 0, keyboard: 0 });
	});

	it("a view keeps to it: height and top as CSS variables, marked while the keyboard is up, the page back on top when it closes", () => {
		const viewport = installViewport();
		const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		let seen = -1;
		function View() {
			const ref = useRef<HTMLDivElement>(null);
			seen = useViewportFit(ref, true);
			return <div ref={ref} data-testid="view" />;
		}
		render(<View />);
		const view = screen.getByTestId("view");
		expect(view.style.getPropertyValue("--vf-h")).toBe("844px");
		expect(view.hasAttribute("data-keyboard")).toBe(false);
		act(() => viewport.move(508, 40));
		expect(view.style.getPropertyValue("--vf-h")).toBe("508px");
		expect(view.style.getPropertyValue("--vf-t")).toBe("40px");
		expect(view.hasAttribute("data-keyboard")).toBe(true);
		expect(seen).toBe(296);
		expect(document.documentElement.classList.contains(KEYBOARD_OPEN_CLASS)).toBe(true);
		act(() => viewport.move(844, 0));
		expect(view.hasAttribute("data-keyboard")).toBe(false);
		expect(document.documentElement.classList.contains(KEYBOARD_OPEN_CLASS)).toBe(false);
		expect(scroll).toHaveBeenCalledWith(0, 0);
		scroll.mockRestore();
	});

	it("does nothing off a phone", () => {
		const viewport = installViewport();
		function View() {
			const ref = useRef<HTMLDivElement>(null);
			useViewportFit(ref, false);
			return <div ref={ref} data-testid="view" />;
		}
		render(<View />);
		act(() => viewport.move(508));
		expect(screen.getByTestId("view").style.getPropertyValue("--vf-h")).toBe("");
	});
});

describe("the terminal's key row", () => {
	it("sends what a terminal expects", () => {
		expect(keySequence("shift-tab", false)).toBe("\x1b[Z");
		expect(keySequence("enter", false)).toBe("\r");
		expect(keySequence("ctrl-c", false)).toBe("\x03");
		expect(keySequence("ctrl-d", false)).toBe("\x04");
		expect(keySequence("ctrl-l", false)).toBe("\x0c");
		expect(keySequence("ctrl-r", false)).toBe("\x12");
		expect(keySequence("backspace", false)).toBe("\x7f");
		expect(keySequence("delete", false)).toBe("\x1b[3~");
		expect(keySequence("home", false)).toBe("\x1b[H");
		expect(keySequence("end", true)).toBe("\x1bOF");
		expect(keySequence("page-up", false)).toBe("\x1b[5~");
		expect(keySequence("f1", false)).toBe("\x1bOP");
		expect(keySequence("f5", false)).toBe("\x1b[15~");
		expect(keySequence("f12", false)).toBe("\x1b[24~");
		expect(keySequence("dollar", false)).toBe("$");
		expect(keySequence("greater", false)).toBe(">");
	});

	it("Ctrl and Alt: one tap for the next key, two quick taps held, a tap of a held one lets go", () => {
		expect(tapLatch("off", 10_000)).toBe("once");
		expect(tapLatch("once", DOUBLE_TAP_MS)).toBe("lock");
		expect(tapLatch("once", DOUBLE_TAP_MS + 1)).toBe("off");
		expect(tapLatch("lock", 10)).toBe("off");
		// After a key: the one-key modifier lets go, the held one stays.
		expect(afterKey({ ctrl: "once", alt: "lock" })).toEqual({ ctrl: "off", alt: "lock" });
		expect(withModifiers("c", { ctrl: "once", alt: "off" })).toBe("\x03");
		expect(withModifiers("x", { ctrl: "lock", alt: "lock" })).toBe("\x1b\x18");
		expect(withModifiers("x", NO_MODIFIERS)).toBe("x");
	});

	it("a held key repeats after a pause, until let go", () => {
		vi.useFakeTimers();
		const sent: number[] = [];
		const stop = repeatKey(() => sent.push(Date.now()));
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(REPEAT_DELAY_MS - 1);
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(1 + REPEAT_INTERVAL_MS * 3);
		expect(sent).toHaveLength(4);
		stop();
		vi.advanceTimersByTime(1_000);
		expect(sent).toHaveLength(4);
	});

	const labels: BarLabels = {
		bar: "Phím phụ",
		esc: "Esc",
		tab: "Tab",
		shiftTab: "Shift+Tab",
		ctrl: "Ctrl",
		alt: "Alt",
		held: (key) => `${key} (giữ)`,
		up: "Mũi tên lên",
		down: "Mũi tên xuống",
		left: "Mũi tên trái",
		right: "Mũi tên phải",
		enter: "Enter",
		interrupt: "Ctrl+C (dừng)",
		backspace: "Xoá lùi",
		paste: "Dán",
		copy: "Sao chép",
		more: "Thêm phím",
		liveInput: "Nhập trực tiếp",
		tapToType: "Chạm để hiện bàn phím",
		hideKeyboard: "Ẩn bàn phím",
		mic: "Nói để nhập",
		micStop: "Dừng nghe",
		micDenied: "Chưa được phép dùng micro.",
		image: "Gửi ảnh vào terminal",
		imageSending: (pct) => `Đang gửi ảnh… ${pct}%`,
		imageFailed: "Không gửi được ảnh. Thử lại.",
		imageTooLarge: "Ảnh quá lớn để gửi.",
	};

	it("puts the AI's keys first, says which modifiers are on, and keeps the rest behind 'more'", async () => {
		const keys: string[] = [];
		const toggles: [string, number][] = [];
		let keyboard = 0;
		let pasted = 0;
		let copied = 0;
		let more = 0;
		const texts: string[] = [];
		const { rerender } = render(
			<MobileKeyBar
				labels={labels}
				mods={NO_MODIFIERS}
				keyboard={false}
				row={rowOf(EMPTY_PREFS)}
				custom={[]}
				onToggle={(m, since) => toggles.push([m, since])}
				onKey={(k) => keys.push(k)}
				onText={(text) => texts.push(text)}
				onPaste={() => (pasted += 1)}
				onCopy={() => (copied += 1)}
				onKeyboard={() => (keyboard += 1)}
				onMore={() => (more += 1)}
			/>,
		);
		const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
		expect(names.slice(0, 8)).toEqual(["Esc", "Tab", "Shift+Tab", "Ctrl", "Alt", "Mũi tên trái", "Mũi tên lên", "Mũi tên xuống"]);
		// The key that hides the keyboard shows only while it is up (the live input brings it up).
		expect(screen.queryByRole("button", { name: "Ẩn bàn phím" })).toBeNull();
		expect(names).toContain("Ctrl+C (dừng)");
		expect(screen.queryByText("F5")).toBeNull();
		// Copy and Paste are words on the keys, not icons, and each does its own job.
		expect(screen.getByRole("button", { name: "Sao chép" }).textContent).toBe("Sao chép");
		expect(screen.getByRole("button", { name: "Dán" }).textContent).toBe("Dán");
		await userEvent.click(screen.getByRole("button", { name: "Sao chép" }));
		await userEvent.click(screen.getByRole("button", { name: "Dán" }));
		expect([copied, pasted]).toEqual([1, 1]);
		pasted = 0;
		await userEvent.click(screen.getByRole("button", { name: "Shift+Tab" }));
		await userEvent.click(screen.getByRole("button", { name: "Ctrl+C (dừng)" }));
		expect(keys).toEqual(["shift-tab", "ctrl-c"]);
		await userEvent.click(screen.getByRole("button", { name: "Ctrl" }));
		await userEvent.click(screen.getByRole("button", { name: "Ctrl" }));
		expect(toggles.map(([m]) => m)).toEqual(["ctrl", "ctrl"]);
		expect(toggles[1]?.[1]).toBeLessThan(DOUBLE_TAP_MS);
		const own = { id: "c:1", label: "ls", send: "ls\r" };
		rerender(
			<MobileKeyBar
				labels={labels}
				mods={{ ctrl: "lock", alt: "once" }}
				keyboard
				row={["ctrl", "alt", "c:1"]}
				custom={[own]}
				onToggle={() => undefined}
				onKey={() => undefined}
				onText={(text) => texts.push(text)}
				onPaste={() => undefined}
				onCopy={() => undefined}
				onKeyboard={() => undefined}
				onMore={() => (more += 1)}
			/>,
		);
		const ctrl = screen.getByRole("button", { name: "Ctrl (giữ)" });
		expect(ctrl.getAttribute("aria-pressed")).toBe("true");
		expect(ctrl.getAttribute("data-latch")).toBe("lock");
		expect(screen.getByRole("button", { name: "Alt" }).getAttribute("data-latch")).toBe("once");
		expect(screen.getAllByRole("button")[0]?.getAttribute("aria-label")).toBe("Ẩn bàn phím");
		// A key of the user's own sends its text; "more" opens the sheet.
		await userEvent.click(screen.getByRole("button", { name: "ls" }));
		expect(texts).toEqual(["ls\r"]);
		await userEvent.click(screen.getByRole("button", { name: "Thêm phím" }));
		expect(more).toBe(1);
		expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
		expect(keyboard + pasted).toBe(0);
	});
});
