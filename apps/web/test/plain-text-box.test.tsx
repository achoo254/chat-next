import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlainTextBox, commandToken, type OpenToken, type PlainTextBoxHandle, type TextSelection } from "../src/components/plain-text-box.tsx";
import { mentionAt } from "../src/machines/composer.tsx";
import { boxPlaceholder, boxValue } from "./support/plain-text-box.ts";

interface HostProps {
	initial?: string;
	disabled?: boolean;
	onKeyDown?: (event: KeyboardEvent) => void;
	onPaste?: (event: ClipboardEvent) => void;
	onChange?: (value: string, selection: TextSelection) => void;
}

/** A composer in miniature: the value in state, buttons that set it from outside. */
function Host({ initial = "", disabled = false, onKeyDown, onPaste, onChange }: HostProps) {
	const [value, setValue] = useState(initial);
	const box = useRef<PlainTextBoxHandle>(null);
	return (
		<>
			<PlainTextBox
				ref={box}
				ariaLabel="Tin nhắn"
				placeholder="Nhập tin nhắn"
				value={value}
				disabled={disabled}
				data-composer=""
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onValueChange={(next, selection) => {
					setValue(next);
					onChange?.(next, selection);
				}}
			/>
			<output data-testid="value">{value}</output>
			<button type="button" onClick={() => setValue("")}>
				clear
			</button>
			<button type="button" onClick={() => setValue("draft back")}>
				draft
			</button>
			<button
				type="button"
				onClick={() => {
					box.current?.setSelection(5);
					setValue("hello world");
				}}
			>
				set with caret
			</button>
			<button type="button" onClick={() => box.current?.setSelection(2)}>
				caret after two
			</button>
			<button type="button" onClick={() => box.current?.insertText("🙂")}>
				emoji
			</button>
		</>
	);
}

const field = (): HTMLElement => screen.getByRole("textbox", { name: "Tin nhắn" });
const state = (): string => screen.getByTestId("value").textContent ?? "";

/** A paste event carrying clipboard data, as a browser sends it. */
function paste(target: HTMLElement, data: Record<string, string>, files: File[] = []): void {
	fireEvent.paste(target, { clipboardData: { files, types: Object.keys(data), getData: (type: string) => data[type] ?? "" } });
}

describe("the plain text message box", () => {
	it("is an editable div with the textbox role, its label and plain text attributes", () => {
		render(<Host />);
		const box = field();
		expect(box.tagName).toBe("DIV");
		expect(box.getAttribute("contenteditable")).toBe("true");
		expect(box.getAttribute("aria-multiline")).toBe("true");
		expect(box.getAttribute("autocomplete")).toBe("off");
		expect(box.getAttribute("autocorrect")).toBe("off");
		expect(box.getAttribute("translate")).toBe("no");
		expect(box.hasAttribute("data-composer")).toBe(true);
		expect(box.classList.contains("plain-text-box")).toBe(true);
	});

	it("reports what is typed, a line break as \\n and nothing more at the end", async () => {
		const onChange = vi.fn<(value: string, selection: TextSelection) => void>();
		const user = userEvent.setup();
		render(<Host onChange={onChange} />);
		await user.type(field(), "ab");
		await user.keyboard("{Shift>}{Enter}{/Shift}");
		expect(state()).toBe("ab\n");
		await user.keyboard("cd");
		expect(state()).toBe("ab\ncd");
		expect(boxValue(field())).toBe("ab\ncd");
		expect(onChange).toHaveBeenLastCalledWith("ab\ncd", { start: 5, end: 5 });
		expect(field().querySelectorAll("div, b, span")).toHaveLength(0);
	});

	it("breaks the line on Enter unless the composer takes the key first", async () => {
		const user = userEvent.setup();
		const { unmount } = render(<Host />);
		await user.type(field(), "a{Enter}b");
		expect(state()).toBe("a\nb");
		unmount();
		const onKeyDown = vi.fn((event: KeyboardEvent) => {
			if (event.key === "Enter") event.preventDefault();
		});
		render(<Host onKeyDown={onKeyDown} />);
		await user.type(field(), "a{Enter}b");
		expect(state()).toBe("ab");
		expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
	});

	it("takes only the plain text of a paste, never its HTML", async () => {
		const user = userEvent.setup();
		render(<Host />);
		await user.type(field(), "x");
		paste(field(), { "text/html": "<b>bold</b><img src=x><p>para</p>", "text/plain": "bold\r\npara" });
		expect(state()).toBe("xbold\npara");
		expect(field().querySelector("b, img")).toBeNull();
	});

	it("leaves a paste the composer took (files) to the composer", async () => {
		const user = userEvent.setup();
		const onPaste = vi.fn((event: ClipboardEvent) => event.preventDefault());
		render(<Host onPaste={onPaste} />);
		await user.type(field(), "x");
		const shot = new File(["png"], "shot.png", { type: "image/png" });
		paste(field(), { "text/plain": "" }, [shot]);
		expect(onPaste).toHaveBeenCalledTimes(1);
		expect(state()).toBe("x");
	});

	it("shows a value set from outside, the caret at its end or where asked", async () => {
		const user = userEvent.setup();
		render(<Host initial="saved" />);
		expect(boxValue(field())).toBe("saved");
		await user.click(screen.getByRole("button", { name: "draft" }));
		expect(boxValue(field())).toBe("draft back");
		await user.click(screen.getByRole("button", { name: "set with caret" }));
		expect(boxValue(field())).toBe("hello world");
		// The caret stays where it was asked: typing goes in the middle.
		act(() => field().focus());
		await user.keyboard(",");
		expect(state()).toBe("hello, world");
		await user.click(screen.getByRole("button", { name: "clear" }));
		expect(boxValue(field())).toBe("");
	});

	it("puts text in at the caret without taking the focus, and undo takes it back", async () => {
		const user = userEvent.setup();
		render(<Host />);
		await user.type(field(), "ab cd");
		// jsdom sends no selectionchange, so arrow keys would not move the editor's caret here.
		await user.click(screen.getByRole("button", { name: "caret after two" }));
		expect(screen.getByRole("button", { name: "caret after two" })).toBe(document.activeElement);
		const emoji = screen.getByRole("button", { name: "emoji" });
		act(() => emoji.focus());
		act(() => emoji.click());
		expect(state()).toBe("ab🙂 cd");
		expect(document.activeElement).toBe(emoji);
		act(() => field().focus());
		await user.keyboard("{Control>}z{/Control}");
		expect(state()).toBe("ab cd");
	});

	it("writes nothing into the box while an IME composes, and catches up when it ends", async () => {
		const onKeyDown = vi.fn();
		render(<Host initial="viet" onKeyDown={onKeyDown} />);
		const box = field();
		act(() => box.focus());
		fireEvent.compositionStart(box);
		// Enter that commits the composition is the IME's, not the composer's.
		fireEvent.keyDown(box, { key: "Enter", isComposing: true });
		fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
		expect(onKeyDown).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "clear" }));
		expect(boxValue(box)).toBe("viet");
		fireEvent.compositionEnd(box);
		await waitFor(() => expect(boxValue(box)).toBe(""));
	});

	it("is disabled without being editable or focusable, its placeholder still shown", () => {
		render(<Host disabled />);
		const box = field();
		expect(box.getAttribute("contenteditable")).toBe("false");
		expect(box.getAttribute("aria-disabled")).toBe("true");
		expect(box.hasAttribute("tabindex")).toBe(false);
		expect(box.querySelector("p")?.getAttribute("data-placeholder")).toBe("Nhập tin nhắn");
	});

	it("shows the placeholder only while empty", async () => {
		const user = userEvent.setup();
		render(<Host />);
		const box = field();
		expect(boxPlaceholder(box)).toBe("Nhập tin nhắn");
		expect(box.querySelector("p.is-editor-empty")?.getAttribute("data-placeholder")).toBe("Nhập tin nhắn");
		await user.type(box, "a");
		expect(box.querySelector("p.is-editor-empty")).toBeNull();
		await user.clear(box);
		expect(box.querySelector("p.is-editor-empty")).not.toBeNull();
	});

	it("shows its text busy and read-only until the editor's code is in, then becomes the editor", async () => {
		// A fresh copy of the module: its editor code is not fetched yet.
		vi.resetModules();
		const fresh = await import("../src/components/plain-text-box.tsx");
		const onValueChange = vi.fn();
		render(<fresh.PlainTextBox ariaLabel="Chờ" placeholder="Nhập" value="nháp cũ" onValueChange={onValueChange} />);
		const box = screen.getByRole("textbox", { name: "Chờ" });
		expect(box.getAttribute("aria-busy")).toBe("true");
		expect(box.getAttribute("aria-disabled")).toBe("true");
		expect(box.hasAttribute("contenteditable")).toBe(false);
		expect(box.textContent).toBe("nháp cũ");
		await waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"));
		expect(box.hasAttribute("aria-busy")).toBe(false);
		expect(box.hasAttribute("aria-disabled")).toBe(false);
		expect(boxValue(box)).toBe("nháp cũ");
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it("stops typing at maxLength and cuts a paste to fit, as a textarea does", async () => {
		const user = userEvent.setup();
		function Limited() {
			const [value, setValue] = useState("");
			return <PlainTextBox ariaLabel="Ngắn" maxLength={5} value={value} onValueChange={setValue} />;
		}
		render(<Limited />);
		const box = screen.getByRole("textbox", { name: "Ngắn" });
		await user.type(box, "abc");
		paste(box, { "text/plain": "xyz" });
		expect(boxValue(box)).toBe("abcxy");
		await user.type(box, "q");
		expect(boxValue(box)).toBe("abcxy");
	});
});

/** A composer in miniature with two triggers: "/" as the whole message, "@" at the start or after a space. */
function Suggesting({ onComposerKey }: { onComposerKey?: (event: KeyboardEvent) => void }) {
	const [value, setValue] = useState("");
	const [slash, setSlash] = useState<OpenToken | null>(null);
	const [at, setAt] = useState<OpenToken | null>(null);
	const box = useRef<PlainTextBoxHandle>(null);
	/** Enter picks, Esc closes; other keys go on to the composer. */
	const listKeys = (token: OpenToken | null, pick: string) => (event: KeyboardEvent) => {
		if (event.key === "Escape") return true;
		if (event.key !== "Enter" || event.shiftKey || token === null) return false;
		event.preventDefault();
		token.replace(pick);
		return true;
	};
	const shown = (token: OpenToken | null) => (token === null ? "closed" : `${token.query} [${token.range.start},${token.range.end}]`);
	return (
		<>
			<PlainTextBox
				ref={box}
				ariaLabel="Soạn"
				value={value}
				onValueChange={setValue}
				onKeyDown={onComposerKey}
				suggestions={[
					{ char: "/", find: (text) => commandToken(text), onChange: setSlash, onKeyDown: listKeys(slash, "/review ") },
					{ char: "@", find: mentionAt, onChange: setAt, onKeyDown: listKeys(at, "@src/app.ts") },
				]}
			/>
			<output data-testid="value">{value}</output>
			<output data-testid="slash">{shown(slash)}</output>
			<output data-testid="at">{shown(at)}</output>
			{/* Moves the caret as a composer does, the focus kept in the box. */}
			<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => box.current?.setSelection(5)}>
				caret after five
			</button>
			<button type="button">elsewhere</button>
			{/* Picks with the mouse, the focus kept in the box as the composers' lists do. */}
			<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => at?.replace("@lib/")}>
				pick lib
			</button>
		</>
	);
}

describe("suggestions in the message box", () => {
	const soan = (): HTMLElement => screen.getByRole("textbox", { name: "Soạn" });
	const out = (id: string): string => screen.getByTestId(id).textContent ?? "";

	it("opens a token at its trigger, follows its query and closes when the rule no longer finds it", async () => {
		const user = userEvent.setup();
		render(<Suggesting />);
		await user.type(soan(), "/re");
		expect(out("slash")).toBe("re [0,3]");
		expect(out("at")).toBe("closed");
		await user.type(soan(), "v");
		expect(out("slash")).toBe("rev [0,4]");
		await user.type(soan(), " ");
		expect(out("slash")).toBe("closed");
	});

	it("watches both triggers in one box: '/' as the whole message, '@' after a space or a line break", async () => {
		const user = userEvent.setup();
		render(<Suggesting />);
		await user.type(soan(), "/a @sr");
		expect(out("slash")).toBe("closed");
		expect(out("at")).toBe("sr [3,6]");
		await user.keyboard("{Shift>}{Enter}{/Shift}@x");
		expect(out("at")).toBe("x [7,9]");
		// "/" on a later line is not a command.
		await user.keyboard("{Shift>}{Enter}{/Shift}/re");
		expect(out("slash")).toBe("closed");
		expect(out("at")).toBe("closed");
	});

	it("never opens '@' inside an e-mail address, as the rule says", async () => {
		const user = userEvent.setup();
		render(<Suggesting />);
		await user.type(soan(), "abc@x.com");
		expect(out("at")).toBe("closed");
		await user.type(soan(), " @");
		expect(out("at")).toBe(" [10,11]");
	});

	it("picks with Enter in place of the token in the middle of the text, the caret after it, undo taking it back", async () => {
		const onComposerKey = vi.fn();
		const user = userEvent.setup();
		render(<Suggesting onComposerKey={onComposerKey} />);
		await user.type(soan(), "hello world");
		await user.click(screen.getByRole("button", { name: "caret after five" }));
		await user.keyboard(" @ap");
		expect(out("value")).toBe("hello @ap world");
		expect(out("at")).toBe("ap [6,9]");
		await user.keyboard("{Enter}");
		expect(out("value")).toBe("hello @src/app.ts world");
		// The list took Enter: the composer never saw it (it would have sent).
		expect(onComposerKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
		await user.keyboard("!");
		expect(out("value")).toBe("hello @src/app.ts! world");
		// The pick is its own undo step: undo brings back what was typed.
		await user.keyboard("{Control>}z{/Control}");
		expect(out("value")).toBe("hello @ap world");
	});

	it("picks with the mouse, the focus staying in the box", async () => {
		const user = userEvent.setup();
		render(<Suggesting />);
		await user.type(soan(), "xem @li");
		await user.click(screen.getByRole("button", { name: "pick lib" }));
		expect(out("value")).toBe("xem @lib/");
		expect(document.activeElement).toBe(soan());
		// A folder picked keeps the token open on its path.
		expect(out("at")).toBe("lib/ [4,9]");
	});

	it("closes on Esc, the text kept, and opens again once the text changes", async () => {
		const onComposerKey = vi.fn();
		const user = userEvent.setup();
		render(<Suggesting onComposerKey={onComposerKey} />);
		await user.type(soan(), "@ab");
		await user.keyboard("{Escape}");
		expect(out("at")).toBe("closed");
		expect(out("value")).toBe("@ab");
		expect(onComposerKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
		await user.keyboard("c");
		expect(out("at")).toBe("abc [0,4]");
	});

	it("closes when the box loses the focus and opens again when it comes back", async () => {
		const user = userEvent.setup();
		render(<Suggesting />);
		await user.type(soan(), "/rev");
		expect(out("slash")).toBe("rev [0,4]");
		await user.click(screen.getByRole("button", { name: "elsewhere" }));
		expect(out("slash")).toBe("closed");
		act(() => soan().focus());
		await waitFor(() => expect(out("slash")).toBe("rev [0,4]"));
	});

	it("opens nothing while an IME composes, and hands it no keys", async () => {
		const onComposerKey = vi.fn();
		const user = userEvent.setup();
		render(<Suggesting onComposerKey={onComposerKey} />);
		const box = soan();
		act(() => box.focus());
		fireEvent.compositionStart(box);
		await user.keyboard("@a");
		expect(out("value")).toBe("@a");
		expect(out("at")).toBe("closed");
		fireEvent.keyDown(box, { key: "Enter", isComposing: true });
		expect(out("value")).toBe("@a");
		fireEvent.compositionEnd(box);
		await user.keyboard("b");
		expect(out("at")).toBe("ab [0,3]");
		expect(onComposerKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
	});
});
